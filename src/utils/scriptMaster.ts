import { STORY_ANALYSIS_SCHEMA, applyStoryAnalysis, createEmptyStoryProject } from './storyProduction.ts';
import type { VideoEditClip } from './videoEdit.ts';

const SCRIPT_MASTER_VIDEO_EDIT_DEFAULT_DATA = {
  clips: [],
  selectedClipId: '',
  outputVersions: [],
  settings: {
    aspect: 'first', resolution: 'first', transition: 'none', transitionDuration: 0.8,
    filter: 'none', audio: 'keep', targetDuration: 0, defaultClipDuration: 5,
    importSortMode: 'current', defaultTrimMode: 'full', audioFilter: 'all',
    safeAreaOverlay: 'none', autoCreateOutputNode: false, outputPreset: 'custom', creatorTemplate: 'manual',
  },
  job: { status: 'idle', progress: 0 },
  videoUrl: '', videoUrls: [], directVideoUrl: '', directVideoUrls: [], draftVideoUrls: [], directDraftVideoUrls: [],
  audioUrl: '', audioUrls: [], directAudioUrl: '', directAudioUrls: [], audioFileName: '', audioFileSize: 0, audioMime: '',
  coverImageUrl: '', coverDirectImageUrl: '', coverFrameTime: 0, coverFileName: '', coverFileSize: 0,
  fileName: '', fileSize: 0, mime: 'video/mp4', status: 'idle', error: '',
} as const;

export const SCRIPT_MASTER_PROJECT_SCHEMA = 't8-script-master-project-v1' as const;
export const SCRIPT_MASTER_PROJECT_VERSION = 1 as const;

export type ScriptMasterDomain =
  | 'unconfirmed'
  | 'narrative'
  | 'ecommerce'
  | 'advertising'
  | 'music-video'
  | 'documentary'
  | 'tutorial';

export type ScriptMasterMediaKind = 'image' | 'video' | 'audio';
export type ScriptMasterAssetKind =
  | 'image'
  | 'video'
  | 'voice-profile'
  | 'dialogue-audio'
  | 'music'
  | 'ambience'
  | 'sfx';
export type ScriptMasterScope = 'project' | 'scene' | 'shot' | 'custom';
export type ScriptMasterTrackGroup = 'picture' | 'transition' | 'reference' | 'dialogue' | 'sound';
export type ScriptMasterAudioRole = 'dialogue' | 'voiceover' | 'music' | 'ambience' | 'sfx';
export type ScriptMasterIssueSeverity = 'blocker' | 'warning';

export interface RationalTime {
  value: number;
  rate: number;
}

export interface RationalTimeRange {
  start: RationalTime;
  end: RationalTime;
}

export interface ScriptMasterSourceSpan {
  id: string;
  documentId: string;
  startLine: number;
  endLine: number;
  startChar: number;
  endChar: number;
  text: string;
}

export interface ScriptMasterSourceDocument {
  id: string;
  name: string;
  format: 'text' | 'markdown' | 'fountain' | 'json';
  language: string;
  content: string;
  contentHash: string;
  importedAt: string;
  revision: number;
  spans: ScriptMasterSourceSpan[];
}

export interface ScriptMasterEntity {
  id: string;
  kind: 'character' | 'scene' | 'prop' | 'product' | 'fact';
  name: string;
  aliases: string[];
  sourceSpanIds: string[];
  confidence: number;
  status: 'source-backed' | 'unresolved' | 'confirmed' | 'locked';
  revision: number;
}

export interface ScriptMasterScene {
  id: string;
  title: string;
  sourceSpanIds: string[];
  shotIds: string[];
  revision: number;
}

export interface ScriptMasterShot {
  id: string;
  sceneId: string;
  title: string;
  purpose: string;
  visualDescription: string;
  action: string;
  shotSize: string;
  camera: string;
  transitionIn: string;
  transitionOut: string;
  transitionInFrames: number;
  range: RationalTimeRange;
  sourceSpanIds: string[];
  characterIds: string[];
  bindingIds: string[];
  mustInclude: string[];
  mustAvoid: string[];
  locked: boolean;
  revision: number;
}

export interface ScriptMasterDialogueLine {
  id: string;
  shotId: string;
  speakerId: string | null;
  speakerName: string;
  text: string;
  emotion: string;
  range: RationalTimeRange;
  sourceSpanIds: string[];
  allowAcrossShots: boolean;
  revision: number;
}

export interface ScriptMasterAudioEvent {
  id: string;
  shotId: string;
  role: ScriptMasterAudioRole;
  description: string;
  range: RationalTimeRange;
  assetId: string | null;
  sourceSpanIds: string[];
  volume: number;
  fadeInFrames: number;
  fadeOutFrames: number;
  duckDialogue: boolean;
  revision: number;
}

export interface ScriptMasterAsset {
  id: string;
  kind: ScriptMasterAssetKind;
  mediaKind: ScriptMasterMediaKind;
  name: string;
  alias: string;
  url: string;
  source: 'local' | 'upstream' | 'resource-library' | 'generated' | 'unresolved';
  sourceKey: string;
  revision: number;
  contentHash: string;
  locked: boolean;
  durationFrames: number | null;
  width: number | null;
  height: number | null;
  mime: string;
  hasAudio: boolean | null;
  waveformPeaks: number[];
  probeStatus: 'unprobed' | 'probing' | 'ready' | 'error';
  probeError: string;
  lastProbedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ScriptMasterBinding {
  id: string;
  assetId: string;
  alias: string;
  role: string;
  scope: ScriptMasterScope;
  sceneId: string | null;
  shotIds: string[];
  range: RationalTimeRange | null;
  trackId: string;
  required: boolean;
  locked: boolean;
  assetRevision: number;
  contentHash: string;
  provenance: 'user' | 'source' | 'upstream' | 'imported' | 'ai-suggested';
  revision: number;
}

export interface ScriptMasterTimelineTrack {
  id: string;
  group: ScriptMasterTrackGroup;
  name: string;
  role: string;
  order: number;
  locked: boolean;
  hidden: boolean;
  muted: boolean;
  assetId: string | null;
}

export interface ScriptMasterTimelineItem {
  id: string;
  trackId: string;
  kind: 'shot' | 'transition' | 'reference' | 'dialogue' | 'audio';
  range: RationalTimeRange;
  shotId: string | null;
  assetId: string | null;
  bindingId: string | null;
  dialogueLineId: string | null;
  audioEventId: string | null;
  label: string;
  locked: boolean;
  revision: number;
}

export interface ScriptMasterTimeline {
  tracks: ScriptMasterTimelineTrack[];
  items: ScriptMasterTimelineItem[];
  selectedItemIds: string[];
  playhead: RationalTime;
  zoom: number;
  snap: boolean;
}

export interface ScriptMasterProviderSelection {
  provider: string;
  model: string;
  version: string;
}

export type ScriptMasterAnalysisCandidateStatus = 'candidate' | 'accepted' | 'rejected' | 'stale';

export interface ScriptMasterAnalysisShotSuggestion {
  shotId: string;
  confidence: number;
  sourceSpanIds: string[];
  fields: Partial<Pick<ScriptMasterShot,
    'title' | 'purpose' | 'visualDescription' | 'action' | 'shotSize' | 'camera' | 'transitionIn' | 'transitionOut' | 'mustInclude' | 'mustAvoid'>>;
}

export interface ScriptMasterAnalysisCandidate {
  id: string;
  status: ScriptMasterAnalysisCandidateStatus;
  provider: string;
  model: string;
  version: string;
  scopeShotIds: string[];
  baseProjectRevision: number;
  sourceDocumentIds: string[];
  sourceContentHashes: string[];
  proposedDomain: ScriptMasterDomain | null;
  confidence: number;
  shotSuggestions: ScriptMasterAnalysisShotSuggestion[];
  unresolvedItems: Array<{ id: string; kind: string; message: string; sourceSpanIds: string[] }>;
  responseDigest: string;
  createdAt: string;
  adoptedAt: string | null;
  error: string;
}

export interface ScriptMasterAnalysisState {
  status: 'idle' | 'running' | 'candidate' | 'accepted' | 'error';
  activeCandidateId: string | null;
  candidates: ScriptMasterAnalysisCandidate[];
  providerCalls: number;
  lastError: string;
  lastRequestedAt: string | null;
}

export interface ScriptMasterDomainPack {
  domain: Exclude<ScriptMasterDomain, 'unconfirmed'>;
  label: string;
  focusFields: string[];
  requiredEvidence: string[];
  criticRules: Array<{ code: string; label: string; severity: ScriptMasterIssueSeverity }>;
}

export type ScriptMasterDownstreamTarget = 'story' | 'director-storyboard' | 'seedance' | 'audio' | 'video-edit';

export interface ScriptMasterDownstreamLink {
  id: string;
  target: ScriptMasterDownstreamTarget;
  nodeId: string;
  projectRevision: number;
  payloadDigest: string;
  patchId: string;
  canvasRevision: number;
  runId: string;
  status: 'planned' | 'applied' | 'stale';
  updatedAt: string;
}

export interface ScriptMasterDownstreamNodePayload {
  target: ScriptMasterDownstreamTarget;
  nodeType: ScriptMasterDownstreamTarget;
  nodeId: string;
  label: string;
  data: Record<string, unknown>;
  payloadDigest: string;
  mode: 'create' | 'update';
}

export interface ScriptMasterWritebackInput {
  schema: 't8-script-master-writeback-v1';
  projectId: string;
  projectRevision: number;
  target: ScriptMasterDownstreamTarget;
  nodeId: string;
  runId: string;
  shots: Array<{
    shotId: string;
    segmentId?: string;
    videoUrl?: string;
    audioUrl?: string;
    taskId?: string;
    provider?: string;
    model?: string;
  }>;
}

export interface ScriptMasterTargetCapability {
  id: string;
  label: string;
  provider: string;
  model: string;
  version: string;
  maxDurationFrames: number;
  maxPromptCharacters: number;
  maxImageReferences: number;
  maxVideoReferences: number;
  maxAudioReferences: number;
  supportsNativeAudio: boolean;
}

export interface ScriptMasterReferenceManifestItem {
  alias: string;
  assetId: string;
  assetRevision: number;
  contentHash: string;
  mediaKind: ScriptMasterMediaKind;
  role: string;
  scope: ScriptMasterScope;
  url: string;
}

export interface ScriptMasterAudioPlanItem {
  id: string;
  shotId: string;
  role: ScriptMasterAudioRole | string;
  range: RationalTimeRange;
  text: string;
  speakerId: string | null;
  assetId: string | null;
  alias: string;
}

export interface ScriptMasterPromptPack {
  id: string;
  projectId: string;
  shotId: string;
  targetCapabilityId: string;
  prompt: string;
  referenceAliases: string[];
  references: ScriptMasterReferenceManifestItem[];
  audioPlan: ScriptMasterAudioPlanItem[];
  sourceSpanIds: string[];
  reverseMap: Array<{ promptSection: string; field: string; sourceSpanIds: string[] }>;
  compiledAt: string;
  projectRevision: number;
  segmentId: string;
  segmentIndex: number;
  segmentCount: number;
  range: RationalTimeRange;
  continuity: { previousSegmentId: string | null; nextSegmentId: string | null; carry: string[] };
  deterministicHash: string;
}

export interface ScriptMasterQualityIssue {
  id: string;
  severity: ScriptMasterIssueSeverity;
  code: string;
  message: string;
  shotId: string | null;
  trackId: string | null;
  assetId: string | null;
  fixes: string[];
}

export interface ScriptMasterQualityReport {
  id: string;
  projectId: string;
  projectRevision: number;
  targetCapabilityId: string;
  createdAt: string;
  blockers: number;
  warnings: number;
  sourceCoveragePercent: number;
  issues: ScriptMasterQualityIssue[];
}

export interface ScriptMasterEdlEntry {
  shotId: string;
  sceneId: string;
  title: string;
  startFrame: number;
  endFrame: number;
  sourceSpanIds: string[];
}

export interface ScriptMasterCompilation {
  promptPacks: ScriptMasterPromptPack[];
  humanPrompt: string;
  referenceManifest: ScriptMasterReferenceManifestItem[];
  audioPlan: ScriptMasterAudioPlanItem[];
  edl: ScriptMasterEdlEntry[];
  qualityReport: ScriptMasterQualityReport;
  deterministicHash: string;
}

export interface ScriptMasterRevision {
  id: string;
  revision: number;
  reason: string;
  createdAt: string;
}

export interface ScriptMasterProject {
  schema: typeof SCRIPT_MASTER_PROJECT_SCHEMA;
  version: typeof SCRIPT_MASTER_PROJECT_VERSION;
  projectId: string;
  title: string;
  domain: ScriptMasterDomain;
  language: string;
  fps: number;
  aspectRatio: string;
  strictMode: boolean;
  targetDurationFrames: number;
  createdAt: string;
  updatedAt: string;
  revision: number;
  sourceDocuments: ScriptMasterSourceDocument[];
  globalConstraints: string[];
  unresolvedItems: Array<{ id: string; kind: string; message: string; sourceSpanIds: string[] }>;
  entities: ScriptMasterEntity[];
  scenes: ScriptMasterScene[];
  shots: ScriptMasterShot[];
  dialogueLines: ScriptMasterDialogueLine[];
  audioEvents: ScriptMasterAudioEvent[];
  assets: ScriptMasterAsset[];
  bindings: ScriptMasterBinding[];
  timeline: ScriptMasterTimeline;
  aliasCounters: Record<ScriptMasterMediaKind, number>;
  providerSelections: Record<'llm' | 'image' | 'video' | 'speech' | 'music', ScriptMasterProviderSelection>;
  analysis: ScriptMasterAnalysisState;
  compileTargets: ScriptMasterTargetCapability[];
  promptPacks: ScriptMasterPromptPack[];
  qualityReports: ScriptMasterQualityReport[];
  locks: Array<{ id: string; targetType: string; targetId: string; field: string; revision: number }>;
  revisions: ScriptMasterRevision[];
  dependencyGraph: Record<string, string[]>;
  lineage: Array<{ id: string; kind: string; sourceId: string; targetId: string; revision: number }>;
  downstreamLinks: ScriptMasterDownstreamLink[];
}

export interface ImportScriptMasterSourceOptions {
  name?: string;
  format?: ScriptMasterSourceDocument['format'];
  language?: string;
  replace?: boolean;
}

export interface AddScriptMasterAssetInput {
  id?: string;
  kind: ScriptMasterAssetKind;
  name?: string;
  url?: string;
  source?: ScriptMasterAsset['source'];
  sourceKey?: string;
  contentHash?: string;
  durationFrames?: number | null;
  width?: number | null;
  height?: number | null;
  mime?: string;
  hasAudio?: boolean | null;
  waveformPeaks?: number[];
  probeStatus?: ScriptMasterAsset['probeStatus'];
  probeError?: string;
  scope?: ScriptMasterScope;
  sceneId?: string | null;
  shotIds?: string[];
  range?: RationalTimeRange | null;
  role?: string;
  trackGroup?: 'reference' | 'sound';
  required?: boolean;
}

export const DEFAULT_SCRIPT_MASTER_TARGET: ScriptMasterTargetCapability = {
  id: 'seedance-2-default-v1',
  label: 'Seedance 2.0 通用能力（待选择具体 Provider）',
  provider: 'unselected',
  model: 'seedance-2.0',
  version: '1',
  maxDurationFrames: 15 * 24,
  maxPromptCharacters: 8_000,
  maxImageReferences: 9,
  maxVideoReferences: 3,
  maxAudioReferences: 3,
  supportsNativeAudio: true,
};

export const SCRIPT_MASTER_TARGET_CAPABILITIES: ScriptMasterTargetCapability[] = [
  DEFAULT_SCRIPT_MASTER_TARGET,
  {
    id: 'seedance-2-fast-native-audio-v1',
    label: 'Seedance 2.0 Fast · 原生音频',
    provider: 'zhenzhen',
    model: 'doubao-seedance-2-0-fast-260128',
    version: '1',
    maxDurationFrames: 15 * 24,
    maxPromptCharacters: 8_000,
    maxImageReferences: 9,
    maxVideoReferences: 3,
    maxAudioReferences: 3,
    supportsNativeAudio: true,
  },
  {
    id: 'seedance-2-pro-native-audio-v1',
    label: 'Seedance 2.0 Pro · 原生音频',
    provider: 'zhenzhen',
    model: 'doubao-seedance-2-0-pro-260128',
    version: '1',
    maxDurationFrames: 15 * 24,
    maxPromptCharacters: 8_000,
    maxImageReferences: 9,
    maxVideoReferences: 3,
    maxAudioReferences: 3,
    supportsNativeAudio: true,
  },
  {
    id: 'seedance-2-video-only-v1',
    label: 'Seedance 2.0 · 外置 AudioPlan',
    provider: 'external',
    model: 'seedance-2.0-video-only',
    version: '1',
    maxDurationFrames: 15 * 24,
    maxPromptCharacters: 8_000,
    maxImageReferences: 9,
    maxVideoReferences: 3,
    maxAudioReferences: 0,
    supportsNativeAudio: false,
  },
];

export const SCRIPT_MASTER_DOMAIN_PACKS: Record<Exclude<ScriptMasterDomain, 'unconfirmed'>, ScriptMasterDomainPack> = {
  narrative: {
    domain: 'narrative', label: '叙事 / 短剧',
    focusFields: ['人物目标', '阻力', '转折', '对白', '情绪弧', '服装/道具/空间连续性'],
    requiredEvidence: ['人物或显式无人物环境镜头', '逐镜可见动作', '对白说话人'],
    criticRules: [
      { code: 'NARRATIVE_CHARACTER_CONTINUITY', label: '人物连续性需有来源或确认', severity: 'warning' },
      { code: 'NARRATIVE_ACTION_STATE', label: '动作结束状态需明确', severity: 'warning' },
    ],
  },
  ecommerce: {
    domain: 'ecommerce', label: '电商 / 产品',
    focusFields: ['商品', '卖点', '证据', '细节特写', '真人使用', 'CTA'],
    requiredEvidence: ['商品或产品素材', '至少一个可验证卖点', 'CTA'],
    criticRules: [
      { code: 'ECOMMERCE_PRODUCT_EVIDENCE', label: '商品卖点必须有原文或素材证据', severity: 'blocker' },
      { code: 'ECOMMERCE_BRAND_LOCK', label: '品牌、包装与材质禁改项需锁定', severity: 'warning' },
    ],
  },
  advertising: {
    domain: 'advertising', label: '广告 / 品牌',
    focusFields: ['受众', '品牌语气', '钩子', '记忆点', 'Logo/包装', 'CTA'],
    requiredEvidence: ['品牌约束', '开场钩子', '结尾行动'],
    criticRules: [
      { code: 'ADVERTISING_BRAND_CONSTRAINT', label: '品牌禁改项必须可追踪', severity: 'blocker' },
      { code: 'ADVERTISING_CTA', label: '结尾 CTA 不应被遗漏', severity: 'warning' },
    ],
  },
  'music-video': {
    domain: 'music-video', label: 'MV / 音乐',
    focusFields: ['歌词段落', 'BPM/拍点', '情绪', '表演', '视觉母题', '重复副歌'],
    requiredEvidence: ['音乐或歌词证据', '段落/拍点关系'],
    criticRules: [
      { code: 'MV_MUSIC_EVIDENCE', label: 'MV 必须保留音乐或歌词来源', severity: 'blocker' },
      { code: 'MV_BEAT_ALIGNMENT', label: '切镜拍点需明确或保持待确认', severity: 'warning' },
    ],
  },
  documentary: {
    domain: 'documentary', label: '纪录 / 访谈',
    focusFields: ['事实', '来源', '发言人', '时间地点', '同期声', 'B-roll'],
    requiredEvidence: ['事实来源', '发言人或明确无发言人', '不可虚构项'],
    criticRules: [
      { code: 'DOCUMENTARY_FACT_SOURCE', label: '事实不得在无来源时自动确认', severity: 'blocker' },
      { code: 'DOCUMENTARY_SPEAKER', label: '同期声发言人必须确定', severity: 'blocker' },
    ],
  },
  tutorial: {
    domain: 'tutorial', label: '口播 / 教学',
    focusFields: ['信息层级', '步骤顺序', '字幕', '示范', '图示', '时长密度'],
    requiredEvidence: ['明确步骤', '台词完整性', '可视化证据'],
    criticRules: [
      { code: 'TUTORIAL_STEP_ORDER', label: '步骤顺序必须来自原文或用户确认', severity: 'blocker' },
      { code: 'TUTORIAL_VISUAL_EVIDENCE', label: '关键步骤需要可见示范', severity: 'warning' },
    ],
  },
};

function emptyAnalysisState(): ScriptMasterAnalysisState {
  return { status: 'idle', activeCandidateId: null, candidates: [], providerCalls: 0, lastError: '', lastRequestedAt: null };
}

const DOMAINS = new Set<ScriptMasterDomain>([
  'unconfirmed', 'narrative', 'ecommerce', 'advertising', 'music-video', 'documentary', 'tutorial',
]);
const MEDIA_KINDS = new Set<ScriptMasterMediaKind>(['image', 'video', 'audio']);
const ASSET_KINDS = new Set<ScriptMasterAssetKind>([
  'image', 'video', 'voice-profile', 'dialogue-audio', 'music', 'ambience', 'sfx',
]);
const TRACK_GROUPS = new Set<ScriptMasterTrackGroup>(['picture', 'transition', 'reference', 'dialogue', 'sound']);
const SCOPE_PRIORITY: Record<ScriptMasterScope, number> = { project: 1, scene: 2, custom: 3, shot: 4 };
const GENERIC_DIALOGUE_LABELS = new Set([
  '场景', '镜头', '画面', '动作', '摄影', '运镜', '转场', '时间', '地点', '人物', '角色', '目的', '必须', '禁止',
]);

function nowIso(): string {
  return new Date().toISOString();
}

function createId(prefix: string): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid ? `${prefix}-${uuid}` : `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function stableId(prefix: string, value: string): string {
  return `${prefix}-${stableHash(value).slice(6)}`;
}

function cleanString(value: unknown, max = 40_000): string {
  return typeof value === 'string' ? value.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim().slice(0, max) : '';
}

function cleanStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean))];
}

function finiteInteger(value: unknown, fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}

export function rationalTime(value: number, rate: number): RationalTime {
  return {
    value: finiteInteger(value, 0, 0),
    rate: finiteInteger(rate, 24, 1, 240),
  };
}

export function rationalRange(startFrame: number, endFrame: number, rate: number): RationalTimeRange {
  const start = finiteInteger(startFrame, 0, 0);
  return {
    start: rationalTime(start, rate),
    end: rationalTime(Math.max(start, finiteInteger(endFrame, start, 0)), rate),
  };
}

export function rationalTimeToFrames(time: RationalTime, targetRate = time.rate): number {
  const sourceRate = finiteInteger(time?.rate, targetRate, 1, 240);
  const value = finiteInteger(time?.value, 0, 0);
  return Math.round(value * finiteInteger(targetRate, sourceRate, 1, 240) / sourceRate);
}

export function rangeDurationFrames(range: RationalTimeRange, targetRate = range?.start?.rate || 24): number {
  return Math.max(0, rationalTimeToFrames(range.end, targetRate) - rationalTimeToFrames(range.start, targetRate));
}

export function formatScriptMasterTimecode(time: RationalTime, fps = time.rate): string {
  const rate = finiteInteger(fps, 24, 1, 240);
  const frames = rationalTimeToFrames(time, rate);
  const hours = Math.floor(frames / (rate * 3600));
  const minutes = Math.floor(frames / (rate * 60)) % 60;
  const seconds = Math.floor(frames / rate) % 60;
  const frame = frames % rate;
  return [hours, minutes, seconds, frame].map((value) => String(value).padStart(2, '0')).join(':');
}

function mediaKindForAssetKind(kind: ScriptMasterAssetKind): ScriptMasterMediaKind {
  if (kind === 'image') return 'image';
  if (kind === 'video') return 'video';
  return 'audio';
}

function aliasPrefix(kind: ScriptMasterMediaKind): string {
  return kind === 'image' ? 'image' : kind === 'video' ? 'video' : 'audio';
}

function aliasNumber(alias: string, kind: ScriptMasterMediaKind): number {
  const match = alias.match(new RegExp(`^@${aliasPrefix(kind)}(\\d+)$`, 'i'));
  return match ? finiteInteger(match[1], 0, 0) : 0;
}

function baseTracks(): ScriptMasterTimelineTrack[] {
  return [
    { id: 'track-picture-main', group: 'picture', name: '画面 · 主轨', role: 'picture', order: 0, locked: false, hidden: false, muted: false, assetId: null },
    { id: 'track-transition-main', group: 'transition', name: '转场 · 剪辑点', role: 'transition', order: 100, locked: false, hidden: false, muted: false, assetId: null },
    { id: 'track-reference-main', group: 'reference', name: '参考 · 总览', role: 'reference', order: 200, locked: false, hidden: false, muted: false, assetId: null },
    { id: 'track-dialogue-main', group: 'dialogue', name: '台词 · 总览', role: 'dialogue', order: 300, locked: false, hidden: false, muted: false, assetId: null },
    { id: 'track-sound-main', group: 'sound', name: '声音 · 总览', role: 'sound', order: 500, locked: false, hidden: false, muted: false, assetId: null },
  ];
}

function defaultProviderSelections(): ScriptMasterProject['providerSelections'] {
  const empty = (): ScriptMasterProviderSelection => ({ provider: '', model: '', version: '' });
  return { llm: empty(), image: empty(), video: empty(), speech: empty(), music: empty() };
}

export function createEmptyScriptMasterProject(input: {
  projectId?: string;
  title?: string;
  domain?: ScriptMasterDomain;
  fps?: number;
  aspectRatio?: string;
} = {}): ScriptMasterProject {
  const createdAt = nowIso();
  const projectId = cleanString(input.projectId, 160) || createId('script-master');
  return {
    schema: SCRIPT_MASTER_PROJECT_SCHEMA,
    version: SCRIPT_MASTER_PROJECT_VERSION,
    projectId,
    title: cleanString(input.title, 160) || '未命名剧本',
    domain: input.domain && DOMAINS.has(input.domain) ? input.domain : 'unconfirmed',
    language: 'zh-CN',
    fps: finiteInteger(input.fps, 24, 1, 120),
    aspectRatio: cleanString(input.aspectRatio, 24) || '16:9',
    strictMode: true,
    targetDurationFrames: 0,
    createdAt,
    updatedAt: createdAt,
    revision: 1,
    sourceDocuments: [],
    globalConstraints: [],
    unresolvedItems: [],
    entities: [],
    scenes: [],
    shots: [],
    dialogueLines: [],
    audioEvents: [],
    assets: [],
    bindings: [],
    timeline: { tracks: baseTracks(), items: [], selectedItemIds: [], playhead: rationalTime(0, finiteInteger(input.fps, 24, 1, 120)), zoom: 1, snap: true },
    aliasCounters: { image: 1, video: 1, audio: 1 },
    providerSelections: defaultProviderSelections(),
    analysis: emptyAnalysisState(),
    compileTargets: SCRIPT_MASTER_TARGET_CAPABILITIES.map((target) => ({
      ...target,
      maxDurationFrames: Math.round(target.maxDurationFrames / 24 * finiteInteger(input.fps, 24, 1, 120)),
    })),
    promptPacks: [],
    qualityReports: [],
    locks: [],
    revisions: [{ id: createId('revision'), revision: 1, reason: '创建剧本大师项目', createdAt }],
    dependencyGraph: {},
    lineage: [],
    downstreamLinks: [],
  };
}

function sanitizeTimeRange(value: unknown, fps: number, fallback?: RationalTimeRange): RationalTimeRange {
  const raw = value && typeof value === 'object' ? value as any : {};
  const start = rationalTimeToFrames(raw.start || fallback?.start || rationalTime(0, fps), fps);
  const end = rationalTimeToFrames(raw.end || fallback?.end || rationalTime(start, fps), fps);
  return rationalRange(start, Math.max(start, end), fps);
}

function normalizedAliasCounters(assets: ScriptMasterAsset[], raw: unknown): Record<ScriptMasterMediaKind, number> {
  const counters = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const result: Record<ScriptMasterMediaKind, number> = { image: 1, video: 1, audio: 1 };
  (['image', 'video', 'audio'] as ScriptMasterMediaKind[]).forEach((kind) => {
    const highest = assets.reduce((max, asset) => asset.mediaKind === kind ? Math.max(max, aliasNumber(asset.alias, kind)) : max, 0);
    result[kind] = Math.max(highest + 1, finiteInteger(counters[kind], 1, 1));
  });
  return result;
}

function assignMissingAliases(
  assets: ScriptMasterAsset[],
  countersInput: Record<ScriptMasterMediaKind, number>,
): { assets: ScriptMasterAsset[]; counters: Record<ScriptMasterMediaKind, number> } {
  const counters = { ...countersInput };
  const used = new Set<string>();
  const nextAssets = assets.map((asset) => {
    const valid = aliasNumber(asset.alias, asset.mediaKind) > 0 && !used.has(asset.alias);
    if (valid && asset.alias) {
      used.add(asset.alias);
      return asset;
    }
    let alias = `@${aliasPrefix(asset.mediaKind)}${counters[asset.mediaKind]}`;
    while (used.has(alias)) {
      counters[asset.mediaKind] += 1;
      alias = `@${aliasPrefix(asset.mediaKind)}${counters[asset.mediaKind]}`;
    }
    used.add(alias);
    counters[asset.mediaKind] += 1;
    return { ...asset, alias };
  });
  return { assets: nextAssets, counters };
}

function sanitizeAnalysisState(value: unknown): ScriptMasterAnalysisState {
  const raw = value && typeof value === 'object' ? value as any : {};
  const candidates: ScriptMasterAnalysisCandidate[] = Array.isArray(raw.candidates) ? raw.candidates.slice(-30).flatMap((candidate: any, index: number) => {
    if (!candidate || typeof candidate !== 'object') return [];
    const status: ScriptMasterAnalysisCandidateStatus = candidate.status === 'accepted' || candidate.status === 'rejected' || candidate.status === 'stale'
      ? candidate.status : 'candidate';
    const proposedDomain = DOMAINS.has(candidate.proposedDomain) && candidate.proposedDomain !== 'unconfirmed'
      ? candidate.proposedDomain as Exclude<ScriptMasterDomain, 'unconfirmed'> : null;
    const shotSuggestions: ScriptMasterAnalysisShotSuggestion[] = Array.isArray(candidate.shotSuggestions)
      ? candidate.shotSuggestions.slice(0, 500).flatMap((suggestion: any) => {
        if (!suggestion || typeof suggestion !== 'object') return [];
        const fields = suggestion.fields && typeof suggestion.fields === 'object' && !Array.isArray(suggestion.fields) ? suggestion.fields : {};
        const nextFields: ScriptMasterAnalysisShotSuggestion['fields'] = {};
        (['title', 'purpose', 'visualDescription', 'action', 'shotSize', 'camera', 'transitionIn', 'transitionOut'] as const).forEach((field) => {
          const text = cleanString(fields[field], field === 'visualDescription' ? 20_000 : 4_000);
          if (text) nextFields[field] = text;
        });
        if (Array.isArray(fields.mustInclude)) nextFields.mustInclude = cleanStringArray(fields.mustInclude);
        if (Array.isArray(fields.mustAvoid)) nextFields.mustAvoid = cleanStringArray(fields.mustAvoid);
        const shotId = cleanString(suggestion.shotId, 160);
        return shotId ? [{
          shotId,
          confidence: Math.max(0, Math.min(1, Number(suggestion.confidence) || 0)),
          sourceSpanIds: cleanStringArray(suggestion.sourceSpanIds),
          fields: nextFields,
        }] : [];
      }) : [];
    return [{
      id: cleanString(candidate.id, 160) || `analysis-candidate-${index + 1}`,
      status,
      provider: cleanString(candidate.provider, 160),
      model: cleanString(candidate.model, 240),
      version: cleanString(candidate.version, 80),
      scopeShotIds: cleanStringArray(candidate.scopeShotIds),
      baseProjectRevision: finiteInteger(candidate.baseProjectRevision, 1, 1),
      sourceDocumentIds: cleanStringArray(candidate.sourceDocumentIds),
      sourceContentHashes: cleanStringArray(candidate.sourceContentHashes),
      proposedDomain,
      confidence: Math.max(0, Math.min(1, Number(candidate.confidence) || 0)),
      shotSuggestions,
      unresolvedItems: Array.isArray(candidate.unresolvedItems) ? candidate.unresolvedItems.slice(0, 200).map((item: any, itemIndex: number) => ({
        id: cleanString(item?.id, 160) || `analysis-unresolved-${itemIndex + 1}`,
        kind: cleanString(item?.kind, 120) || 'analysis',
        message: cleanString(item?.message, 2_000),
        sourceSpanIds: cleanStringArray(item?.sourceSpanIds),
      })) : [],
      responseDigest: cleanString(candidate.responseDigest, 160),
      createdAt: cleanString(candidate.createdAt, 80) || nowIso(),
      adoptedAt: cleanString(candidate.adoptedAt, 80) || null,
      error: cleanString(candidate.error, 2_000),
    }];
  }) : [];
  const activeCandidateId = cleanString(raw.activeCandidateId, 160) || null;
  return {
    status: raw.status === 'running' || raw.status === 'candidate' || raw.status === 'accepted' || raw.status === 'error' ? raw.status : 'idle',
    activeCandidateId: candidates.some((candidate) => candidate.id === activeCandidateId) ? activeCandidateId : null,
    candidates,
    providerCalls: finiteInteger(raw.providerCalls, 0, 0),
    lastError: cleanString(raw.lastError, 2_000),
    lastRequestedAt: cleanString(raw.lastRequestedAt, 80) || null,
  };
}

function sanitizeDownstreamLinks(value: unknown): ScriptMasterDownstreamLink[] {
  const targets = new Set<ScriptMasterDownstreamTarget>(['story', 'director-storyboard', 'seedance', 'audio', 'video-edit']);
  return Array.isArray(value) ? value.slice(-100).flatMap((link: any, index: number) => {
    if (!link || typeof link !== 'object' || !targets.has(link.target)) return [];
    const nodeId = cleanString(link.nodeId, 160);
    return nodeId ? [{
      id: cleanString(link.id, 160) || `downstream-link-${index + 1}`,
      target: link.target,
      nodeId,
      projectRevision: finiteInteger(link.projectRevision, 1, 1),
      payloadDigest: cleanString(link.payloadDigest, 160),
      patchId: cleanString(link.patchId, 160),
      canvasRevision: finiteInteger(link.canvasRevision, 0, 0),
      runId: cleanString(link.runId, 160),
      status: link.status === 'applied' || link.status === 'stale' ? link.status : 'planned',
      updatedAt: cleanString(link.updatedAt, 80) || nowIso(),
    }] : [];
  }) : [];
}

export function sanitizeScriptMasterProject(value: unknown): ScriptMasterProject {
  if (!value || typeof value !== 'object' || (value as any).schema !== SCRIPT_MASTER_PROJECT_SCHEMA) {
    return createEmptyScriptMasterProject();
  }
  const raw = value as any;
  const base = createEmptyScriptMasterProject({
    projectId: cleanString(raw.projectId, 160),
    title: cleanString(raw.title, 160),
    domain: DOMAINS.has(raw.domain) ? raw.domain : 'unconfirmed',
    fps: finiteInteger(raw.fps, 24, 1, 120),
    aspectRatio: cleanString(raw.aspectRatio, 24),
  });
  const fps = base.fps;
  const sourceDocuments: ScriptMasterSourceDocument[] = Array.isArray(raw.sourceDocuments) ? raw.sourceDocuments.map((document: any, index: number) => {
    const id = cleanString(document?.id, 160) || `source-${index + 1}`;
    const content = cleanString(document?.content, 500_000);
    const spans: ScriptMasterSourceSpan[] = Array.isArray(document?.spans) ? document.spans.map((span: any, spanIndex: number) => ({
      id: cleanString(span?.id, 160) || `${id}-span-${spanIndex + 1}`,
      documentId: id,
      startLine: finiteInteger(span?.startLine, spanIndex + 1, 1),
      endLine: finiteInteger(span?.endLine, spanIndex + 1, 1),
      startChar: finiteInteger(span?.startChar, 0, 0),
      endChar: finiteInteger(span?.endChar, 0, 0),
      text: cleanString(span?.text, 20_000),
    })) : [];
    return {
      id,
      name: cleanString(document?.name, 200) || `剧本 ${index + 1}`,
      format: document?.format === 'markdown' || document?.format === 'fountain' || document?.format === 'json' ? document.format : 'text',
      language: cleanString(document?.language, 40) || base.language,
      content,
      contentHash: cleanString(document?.contentHash, 160) || stableHash(content),
      importedAt: cleanString(document?.importedAt, 80) || base.createdAt,
      revision: finiteInteger(document?.revision, 1, 1),
      spans,
    };
  }) : [];
  const entities: ScriptMasterEntity[] = Array.isArray(raw.entities) ? raw.entities.map((entity: any, index: number) => ({
    id: cleanString(entity?.id, 160) || `entity-${index + 1}`,
    kind: entity?.kind === 'scene' || entity?.kind === 'prop' || entity?.kind === 'product' || entity?.kind === 'fact' ? entity.kind : 'character',
    name: cleanString(entity?.name, 160) || `实体 ${index + 1}`,
    aliases: cleanStringArray(entity?.aliases),
    sourceSpanIds: cleanStringArray(entity?.sourceSpanIds),
    confidence: Math.max(0, Math.min(1, Number(entity?.confidence) || 0)),
    status: entity?.status === 'unresolved' || entity?.status === 'confirmed' || entity?.status === 'locked' ? entity.status : 'source-backed',
    revision: finiteInteger(entity?.revision, 1, 1),
  })) : [];
  const shots: ScriptMasterShot[] = Array.isArray(raw.shots) ? raw.shots.map((shot: any, index: number) => ({
    id: cleanString(shot?.id, 160) || `shot-${index + 1}`,
    sceneId: cleanString(shot?.sceneId, 160),
    title: cleanString(shot?.title, 200) || `镜头 ${index + 1}`,
    purpose: cleanString(shot?.purpose, 4_000),
    visualDescription: cleanString(shot?.visualDescription, 20_000),
    action: cleanString(shot?.action, 8_000),
    shotSize: cleanString(shot?.shotSize, 120) || '中景',
    camera: cleanString(shot?.camera, 500) || '固定机位',
    transitionIn: cleanString(shot?.transitionIn, 200) || (index === 0 ? '开场' : '硬切'),
    transitionOut: cleanString(shot?.transitionOut, 200) || '硬切',
    transitionInFrames: finiteInteger(shot?.transitionInFrames, 0, 0),
    range: sanitizeTimeRange(shot?.range, fps),
    sourceSpanIds: cleanStringArray(shot?.sourceSpanIds),
    characterIds: cleanStringArray(shot?.characterIds),
    bindingIds: cleanStringArray(shot?.bindingIds),
    mustInclude: cleanStringArray(shot?.mustInclude),
    mustAvoid: cleanStringArray(shot?.mustAvoid),
    locked: shot?.locked === true,
    revision: finiteInteger(shot?.revision, 1, 1),
  })) : [];
  const scenes: ScriptMasterScene[] = Array.isArray(raw.scenes) ? raw.scenes.map((scene: any, index: number) => ({
    id: cleanString(scene?.id, 160) || `scene-${index + 1}`,
    title: cleanString(scene?.title, 200) || `场景 ${index + 1}`,
    sourceSpanIds: cleanStringArray(scene?.sourceSpanIds),
    shotIds: cleanStringArray(scene?.shotIds),
    revision: finiteInteger(scene?.revision, 1, 1),
  })) : [];
  const dialogueLines: ScriptMasterDialogueLine[] = Array.isArray(raw.dialogueLines) ? raw.dialogueLines.map((line: any, index: number) => ({
    id: cleanString(line?.id, 160) || `dialogue-${index + 1}`,
    shotId: cleanString(line?.shotId, 160),
    speakerId: cleanString(line?.speakerId, 160) || null,
    speakerName: cleanString(line?.speakerName, 160),
    text: cleanString(line?.text, 12_000),
    emotion: cleanString(line?.emotion, 500),
    range: sanitizeTimeRange(line?.range, fps),
    sourceSpanIds: cleanStringArray(line?.sourceSpanIds),
    allowAcrossShots: line?.allowAcrossShots === true,
    revision: finiteInteger(line?.revision, 1, 1),
  })) : [];
  const audioEvents: ScriptMasterAudioEvent[] = Array.isArray(raw.audioEvents) ? raw.audioEvents.map((event: any, index: number) => ({
    id: cleanString(event?.id, 160) || `audio-event-${index + 1}`,
    shotId: cleanString(event?.shotId, 160),
    role: event?.role === 'dialogue' || event?.role === 'voiceover' || event?.role === 'music' || event?.role === 'ambience' ? event.role : 'sfx',
    description: cleanString(event?.description, 4_000),
    range: sanitizeTimeRange(event?.range, fps),
    assetId: cleanString(event?.assetId, 160) || null,
    sourceSpanIds: cleanStringArray(event?.sourceSpanIds),
    volume: Math.max(0, Math.min(2, Number(event?.volume) || 1)),
    fadeInFrames: finiteInteger(event?.fadeInFrames, 0, 0),
    fadeOutFrames: finiteInteger(event?.fadeOutFrames, 0, 0),
    duckDialogue: event?.duckDialogue === true,
    revision: finiteInteger(event?.revision, 1, 1),
  })) : [];
  let assets: ScriptMasterAsset[] = Array.isArray(raw.assets) ? raw.assets.map((asset: any, index: number) => {
    const kind: ScriptMasterAssetKind = ASSET_KINDS.has(asset?.kind) ? asset.kind : 'image';
    const mediaKind = MEDIA_KINDS.has(asset?.mediaKind) ? asset.mediaKind : mediaKindForAssetKind(kind);
    return {
      id: cleanString(asset?.id, 160) || `asset-${index + 1}`,
      kind,
      mediaKind,
      name: cleanString(asset?.name, 200) || `素材 ${index + 1}`,
      alias: cleanString(asset?.alias, 80),
      url: cleanString(asset?.url, 100_000),
      source: asset?.source === 'local' || asset?.source === 'upstream' || asset?.source === 'resource-library' || asset?.source === 'generated' ? asset.source : 'unresolved',
      sourceKey: cleanString(asset?.sourceKey, 1_000),
      revision: finiteInteger(asset?.revision, 1, 1),
      contentHash: cleanString(asset?.contentHash, 160) || stableHash(cleanString(asset?.url, 100_000)),
      locked: asset?.locked === true,
      durationFrames: asset?.durationFrames == null ? null : finiteInteger(asset.durationFrames, 0, 0),
      width: asset?.width == null ? null : finiteInteger(asset.width, 0, 0),
      height: asset?.height == null ? null : finiteInteger(asset.height, 0, 0),
      mime: cleanString(asset?.mime, 160),
      hasAudio: typeof asset?.hasAudio === 'boolean' ? asset.hasAudio : null,
      waveformPeaks: Array.isArray(asset?.waveformPeaks)
        ? asset.waveformPeaks.slice(0, 128).map((peak: unknown) => Math.max(0, Math.min(1, Number(peak) || 0)))
        : [],
      probeStatus: asset?.probeStatus === 'probing' || asset?.probeStatus === 'ready' || asset?.probeStatus === 'error' ? asset.probeStatus : 'unprobed',
      probeError: cleanString(asset?.probeError, 2_000),
      lastProbedAt: cleanString(asset?.lastProbedAt, 80) || null,
      createdAt: cleanString(asset?.createdAt, 80) || base.createdAt,
      updatedAt: cleanString(asset?.updatedAt, 80) || base.updatedAt,
    };
  }) : [];
  const initialCounters = normalizedAliasCounters(assets, raw.aliasCounters);
  const assigned = assignMissingAliases(assets, initialCounters);
  assets = assigned.assets;
  const assetById = new Map(assets.map((asset) => [asset.id, asset]));
  const bindings: ScriptMasterBinding[] = Array.isArray(raw.bindings) ? raw.bindings.map((binding: any, index: number) => {
    const asset = assetById.get(cleanString(binding?.assetId, 160));
    const scope: ScriptMasterScope = binding?.scope === 'scene' || binding?.scope === 'shot' || binding?.scope === 'custom' ? binding.scope : 'project';
    return {
      id: cleanString(binding?.id, 160) || `binding-${index + 1}`,
      assetId: asset?.id || cleanString(binding?.assetId, 160),
      alias: asset?.alias || cleanString(binding?.alias, 80),
      role: cleanString(binding?.role, 160) || asset?.kind || 'reference',
      scope,
      sceneId: cleanString(binding?.sceneId, 160) || null,
      shotIds: cleanStringArray(binding?.shotIds),
      range: binding?.range ? sanitizeTimeRange(binding.range, fps) : null,
      trackId: cleanString(binding?.trackId, 160),
      required: binding?.required !== false,
      locked: binding?.locked === true,
      assetRevision: asset?.revision || finiteInteger(binding?.assetRevision, 1, 1),
      contentHash: asset?.contentHash || cleanString(binding?.contentHash, 160),
      provenance: binding?.provenance === 'source' || binding?.provenance === 'upstream' || binding?.provenance === 'imported' || binding?.provenance === 'ai-suggested' ? binding.provenance : 'user',
      revision: finiteInteger(binding?.revision, 1, 1),
    };
  }).filter((binding: ScriptMasterBinding) => binding.assetId) : [];
  const tracks: ScriptMasterTimelineTrack[] = Array.isArray(raw.timeline?.tracks) ? raw.timeline.tracks.map((track: any, index: number) => ({
    id: cleanString(track?.id, 160) || `track-${index + 1}`,
    group: TRACK_GROUPS.has(track?.group) ? track.group : 'reference',
    name: cleanString(track?.name, 200) || `轨道 ${index + 1}`,
    role: cleanString(track?.role, 160),
    order: finiteInteger(track?.order, index * 10, 0),
    locked: track?.locked === true,
    hidden: track?.hidden === true,
    muted: track?.muted === true,
    assetId: cleanString(track?.assetId, 160) || null,
  })) : baseTracks();
  baseTracks().forEach((track) => {
    if (!tracks.some((item) => item.id === track.id)) tracks.push(track);
  });
  const items: ScriptMasterTimelineItem[] = Array.isArray(raw.timeline?.items) ? raw.timeline.items.map((item: any, index: number) => ({
    id: cleanString(item?.id, 160) || `timeline-item-${index + 1}`,
    trackId: cleanString(item?.trackId, 160),
    kind: item?.kind === 'transition' || item?.kind === 'reference' || item?.kind === 'dialogue' || item?.kind === 'audio' ? item.kind : 'shot',
    range: sanitizeTimeRange(item?.range, fps),
    shotId: cleanString(item?.shotId, 160) || null,
    assetId: cleanString(item?.assetId, 160) || null,
    bindingId: cleanString(item?.bindingId, 160) || null,
    dialogueLineId: cleanString(item?.dialogueLineId, 160) || null,
    audioEventId: cleanString(item?.audioEventId, 160) || null,
    label: cleanString(item?.label, 500),
    locked: item?.locked === true,
    revision: finiteInteger(item?.revision, 1, 1),
  })) : [];
  return {
    ...base,
    title: cleanString(raw.title, 160) || base.title,
    domain: DOMAINS.has(raw.domain) ? raw.domain : 'unconfirmed',
    language: cleanString(raw.language, 40) || base.language,
    strictMode: raw.strictMode !== false,
    targetDurationFrames: finiteInteger(raw.targetDurationFrames, 0, 0),
    createdAt: cleanString(raw.createdAt, 80) || base.createdAt,
    updatedAt: cleanString(raw.updatedAt, 80) || base.updatedAt,
    revision: finiteInteger(raw.revision, 1, 1),
    sourceDocuments,
    globalConstraints: cleanStringArray(raw.globalConstraints),
    unresolvedItems: Array.isArray(raw.unresolvedItems) ? raw.unresolvedItems.map((item: any, index: number) => ({
      id: cleanString(item?.id, 160) || `unresolved-${index + 1}`,
      kind: cleanString(item?.kind, 120) || 'unknown',
      message: cleanString(item?.message, 2_000),
      sourceSpanIds: cleanStringArray(item?.sourceSpanIds),
    })) : [],
    entities,
    scenes,
    shots,
    dialogueLines,
    audioEvents,
    assets,
    bindings,
    timeline: {
      tracks,
      items,
      selectedItemIds: cleanStringArray(raw.timeline?.selectedItemIds),
      playhead: rationalTime(rationalTimeToFrames(raw.timeline?.playhead || rationalTime(0, fps), fps), fps),
      zoom: Math.max(0.25, Math.min(8, Number(raw.timeline?.zoom) || 1)),
      snap: raw.timeline?.snap !== false,
    },
    aliasCounters: assigned.counters,
    providerSelections: {
      ...defaultProviderSelections(),
      ...(raw.providerSelections && typeof raw.providerSelections === 'object' ? raw.providerSelections : {}),
    },
    analysis: sanitizeAnalysisState(raw.analysis),
    compileTargets: Array.isArray(raw.compileTargets) && raw.compileTargets.length ? raw.compileTargets : base.compileTargets,
    promptPacks: Array.isArray(raw.promptPacks) ? raw.promptPacks : [],
    qualityReports: Array.isArray(raw.qualityReports) ? raw.qualityReports : [],
    locks: Array.isArray(raw.locks) ? raw.locks : [],
    revisions: Array.isArray(raw.revisions) ? raw.revisions : base.revisions,
    dependencyGraph: raw.dependencyGraph && typeof raw.dependencyGraph === 'object' ? raw.dependencyGraph : {},
    lineage: Array.isArray(raw.lineage) ? raw.lineage : [],
    downstreamLinks: sanitizeDownstreamLinks(raw.downstreamLinks),
  };
}

function linesWithOffsets(content: string): Array<{ text: string; line: number; start: number; end: number }> {
  const lines = content.split('\n');
  let cursor = 0;
  return lines.map((text, index) => {
    const start = cursor;
    const end = start + text.length;
    cursor = end + 1;
    return { text, line: index + 1, start, end };
  });
}

function sourceSpan(
  documentId: string,
  sourceHash: string,
  line: { text: string; line: number; start: number; end: number },
  suffix: string,
): ScriptMasterSourceSpan {
  return {
    id: stableId('span', `${documentId}:${sourceHash}:${line.line}:${suffix}`),
    documentId,
    startLine: line.line,
    endLine: line.line,
    startChar: line.start,
    endChar: line.end,
    text: line.text,
  };
}

function sceneHeading(text: string): string | null {
  const clean = text.trim().replace(/^#+\s*/, '');
  if (/^(INT\.?|EXT\.?|INT\.?\/EXT\.?|I\/E\.?)\s+/i.test(clean)) return clean;
  const match = clean.match(/^(?:场景|SCENE)\s*\d*\s*[:：.、-]?\s*(.+)$/i);
  return match?.[1]?.trim() || null;
}

function shotHeading(text: string): string | null {
  const clean = text.trim().replace(/^#+\s*/, '');
  const match = clean.match(/^(?:镜头|SHOT)\s*(?:#?\d+)?\s*[:：.、-]?\s*(.*)$/i);
  return match ? match[1].trim() || clean : null;
}

function explicitAudio(text: string): { role: ScriptMasterAudioRole; description: string } | null {
  const trimmed = text.trim();
  const unwrapped = (
    (trimmed.startsWith('[') && trimmed.endsWith(']'))
    || (trimmed.startsWith('【') && trimmed.endsWith('】'))
    || (trimmed.startsWith('(') && trimmed.endsWith(')'))
    || (trimmed.startsWith('（') && trimmed.endsWith('）'))
  ) ? trimmed.slice(1, -1).trim() : trimmed;
  const match = unwrapped.match(/^(BGM|MUSIC|音乐|配乐|环境声|氛围声|AMBIENCE|SFX|音效|VOICEOVER|旁白)\s*[:：]\s*(.+)$/i);
  if (!match) return null;
  const token = match[1].toUpperCase();
  const role: ScriptMasterAudioRole = token === 'BGM' || token === 'MUSIC' || token === '音乐' || token === '配乐'
    ? 'music'
    : token === '环境声' || token === '氛围声' || token === 'AMBIENCE'
      ? 'ambience'
      : token === 'VOICEOVER' || token === '旁白'
        ? 'voiceover'
        : 'sfx';
  return { role, description: match[2].trim() };
}

function explicitDialogue(text: string): { speaker: string; text: string } | null {
  const match = text.trim().match(/^([^:：]{1,24})\s*[:：]\s*(.+)$/);
  if (!match) return null;
  const speaker = match[1].trim();
  if (!speaker || GENERIC_DIALOGUE_LABELS.has(speaker)) return null;
  return { speaker, text: match[2].trim() };
}

function looksLikeFountainSpeaker(text: string): boolean {
  const clean = text.trim().replace(/\s*\([^)]*\)\s*$/, '');
  if (!clean || clean.length > 32 || /[:：,.，。！？!?]/.test(clean)) return false;
  if (/^[A-Z][A-Z0-9 _.'-]{1,30}$/.test(clean)) return true;
  return /^[\p{Script=Han}A-Za-z0-9 _·]{1,10}$/u.test(clean) && !GENERIC_DIALOGUE_LABELS.has(clean);
}

function scriptMasterSpeakerIdentity(nameInput: string): { key: string; name: string; aliases: string[] } {
  const raw = nameInput.trim();
  const qualified = raw.match(/^(.*?)\s*[（(]([^）)]+)[）)]\s*$/);
  if (!qualified) return { key: raw.toLocaleLowerCase(), name: raw, aliases: [] };
  const base = qualified[1].trim();
  const qualifier = qualified[2].trim();
  const deliveryMarker = /^(?:v\.?o\.?|o\.?s\.?|cont['’]?d|旁白|画外音|继续|低声|高声)$/i.test(qualifier);
  if (deliveryMarker) return { key: base.toLocaleLowerCase(), name: base, aliases: [raw] };
  return { key: raw.toLocaleLowerCase(), name: raw, aliases: base ? [base] : [] };
}

function audioRoleTrackName(role: ScriptMasterAudioRole): string {
  if (role === 'dialogue') return 'Dialogue';
  if (role === 'voiceover') return 'Voiceover';
  if (role === 'music') return 'BGM';
  if (role === 'ambience') return 'Ambience';
  return 'SFX';
}

function cloneRange(range: RationalTimeRange): RationalTimeRange {
  return rationalRange(range.start.value, range.end.value, range.start.rate);
}

function markRevision(project: ScriptMasterProject, reason: string): ScriptMasterProject {
  const revision = project.revision + 1;
  const createdAt = nowIso();
  return {
    ...project,
    revision,
    updatedAt: createdAt,
    revisions: [...project.revisions, { id: createId('revision'), revision, reason, createdAt }].slice(-200),
    promptPacks: [],
    analysis: {
      ...project.analysis,
      candidates: project.analysis.candidates.map((candidate) => candidate.status === 'candidate'
        ? { ...candidate, status: 'stale' as const } : candidate),
      activeCandidateId: null,
      status: project.analysis.status === 'running' ? 'running' : project.analysis.status === 'error' ? 'error' : 'idle',
    },
    downstreamLinks: project.downstreamLinks.map((link) => link.projectRevision === revision
      ? link : { ...link, status: 'stale' as const }),
  };
}

function reconcileImportedIdentity(
  previous: ScriptMasterProject,
  nextInput: {
    scenes: ScriptMasterScene[];
    shots: ScriptMasterShot[];
    entities: ScriptMasterEntity[];
    dialogueLines: ScriptMasterDialogueLine[];
    audioEvents: ScriptMasterAudioEvent[];
  },
): typeof nextInput & { changedShotIds: string[]; lockedConflictItems: ScriptMasterProject['unresolvedItems'] } {
  if (!previous.shots.length) return { ...nextInput, changedShotIds: nextInput.shots.map((shot) => shot.id), lockedConflictItems: [] };
  const entityIdMap = new Map<string, string>();
  const entities = nextInput.entities.map((entity, index) => {
    const match = previous.entities.find((candidate) => candidate.kind === entity.kind && candidate.name.toLocaleLowerCase() === entity.name.toLocaleLowerCase())
      || previous.entities[index];
    if (!match || match.kind !== entity.kind) return entity;
    entityIdMap.set(entity.id, match.id);
    const unchanged = match.name === entity.name && JSON.stringify(match.aliases) === JSON.stringify(entity.aliases)
      && JSON.stringify(match.sourceSpanIds) === JSON.stringify(entity.sourceSpanIds);
    return { ...entity, id: match.id, status: match.status === 'locked' ? 'locked' : entity.status, revision: unchanged ? match.revision : match.revision + 1 };
  });
  const sceneIdMap = new Map<string, string>();
  const scenes = nextInput.scenes.map((scene, index) => {
    const match = previous.scenes.find((candidate) => candidate.title === scene.title)
      || previous.scenes[index];
    if (!match) return scene;
    sceneIdMap.set(scene.id, match.id);
    return { ...scene, id: match.id, revision: match.title === scene.title ? match.revision : match.revision + 1 };
  });
  const shotIdMap = new Map<string, string>();
  const changedShotIds: string[] = [];
  const lockedConflictItems: ScriptMasterProject['unresolvedItems'] = [];
  const shots = nextInput.shots.map((shot, index) => {
    const nextSceneId = sceneIdMap.get(shot.sceneId) || shot.sceneId;
    const previousScene = previous.scenes.find((scene) => scene.id === nextSceneId);
    const ordinalInScene = nextInput.shots.filter((candidate) => candidate.sceneId === shot.sceneId).findIndex((candidate) => candidate.id === shot.id);
    const match = previous.shots.find((candidate) => candidate.sceneId === nextSceneId && candidate.title === shot.title)
      || (previousScene ? previous.shots.find((candidate) => candidate.id === previousScene.shotIds[ordinalInScene]) : undefined)
      || previous.shots[index];
    if (!match) return { ...shot, sceneId: nextSceneId, characterIds: shot.characterIds.map((id) => entityIdMap.get(id) || id) };
    shotIdMap.set(shot.id, match.id);
    const parsedComparable = JSON.stringify([shot.title, shot.visualDescription, shot.action]);
    const previousComparable = JSON.stringify([match.title, match.visualDescription, match.action]);
    const changed = parsedComparable !== previousComparable;
    if (changed) changedShotIds.push(match.id);
    if (match.locked && changed) {
      lockedConflictItems.push({
        id: stableId('unresolved', `locked-source-change:${match.id}:${previous.revision}`),
        kind: 'locked-source-change',
        message: `${match.title} 已锁定，源剧本发生变化；已保留锁定内容，需人工对照确认。`,
        sourceSpanIds: shot.sourceSpanIds,
      });
    }
    const preserved = match.locked ? {
      ...match,
      sourceSpanIds: shot.sourceSpanIds,
      sceneId: nextSceneId,
      range: shot.range,
    } : { ...shot, sceneId: nextSceneId, locked: match.locked };
    return {
      ...preserved,
      id: match.id,
      characterIds: shot.characterIds.map((id) => entityIdMap.get(id) || id),
      bindingIds: match.bindingIds,
      revision: changed ? match.revision + 1 : match.revision,
    };
  });
  const dialogueLines = nextInput.dialogueLines.map((line) => {
    const shotId = shotIdMap.get(line.shotId) || line.shotId;
    const nextOrdinal = nextInput.dialogueLines.filter((candidate) => candidate.shotId === line.shotId).findIndex((candidate) => candidate.id === line.id);
    const oldForShot = previous.dialogueLines.filter((candidate) => candidate.shotId === shotId);
    const match = oldForShot.find((candidate) => candidate.speakerName === line.speakerName && candidate.text === line.text) || oldForShot[nextOrdinal];
    const speakerId = line.speakerId ? entityIdMap.get(line.speakerId) || line.speakerId : null;
    if (!match) return { ...line, shotId, speakerId };
    const changed = match.text !== line.text || match.speakerName !== line.speakerName || match.speakerId !== speakerId;
    return { ...line, id: match.id, shotId, speakerId, revision: changed ? match.revision + 1 : match.revision };
  });
  const audioEvents = nextInput.audioEvents.map((event) => {
    const shotId = shotIdMap.get(event.shotId) || event.shotId;
    const nextOrdinal = nextInput.audioEvents.filter((candidate) => candidate.shotId === event.shotId).findIndex((candidate) => candidate.id === event.id);
    const oldForShot = previous.audioEvents.filter((candidate) => candidate.shotId === shotId);
    const match = oldForShot.find((candidate) => candidate.role === event.role && candidate.description === event.description) || oldForShot[nextOrdinal];
    if (!match) return { ...event, shotId };
    const changed = match.role !== event.role || match.description !== event.description;
    return { ...event, id: match.id, shotId, assetId: match.assetId, revision: changed ? match.revision + 1 : match.revision };
  });
  const shotIdsByScene = new Map<string, string[]>();
  shots.forEach((shot) => shotIdsByScene.set(shot.sceneId, [...(shotIdsByScene.get(shot.sceneId) || []), shot.id]));
  return {
    entities,
    shots,
    dialogueLines,
    audioEvents,
    scenes: scenes.map((scene) => ({ ...scene, shotIds: shotIdsByScene.get(scene.id) || [] })),
    changedShotIds,
    lockedConflictItems,
  };
}

export function importScriptMasterSource(
  projectInput: ScriptMasterProject,
  contentInput: string,
  options: ImportScriptMasterSourceOptions = {},
): ScriptMasterProject {
  const project = sanitizeScriptMasterProject(projectInput);
  const content = cleanString(contentInput, 500_000);
  if (!content) return project;
  const hash = stableHash(content);
  const previousDocument = options.replace === false ? undefined : project.sourceDocuments[0];
  const documentId = previousDocument?.id || stableId('source', `${options.name || 'script'}`);
  const importedAt = nowIso();
  const sourceLines = linesWithOffsets(content);
  const spans: ScriptMasterSourceSpan[] = [];
  const entities: ScriptMasterEntity[] = [];
  const scenes: ScriptMasterScene[] = [];
  const shotDrafts: Array<ScriptMasterShot & { bodyLines: string[] }> = [];
  const dialogueDrafts: Array<Omit<ScriptMasterDialogueLine, 'range'> & { order: number }> = [];
  const audioDrafts: Array<Omit<ScriptMasterAudioEvent, 'range'> & { order: number }> = [];
  const entityByName = new Map<string, ScriptMasterEntity>();
  const consumedLineIndexes = new Set<number>();
  let currentScene: ScriptMasterScene | null = null;
  let currentShot: (ScriptMasterShot & { bodyLines: string[] }) | null = null;

  const ensureScene = (lineIndex: number, title = '未分场'): ScriptMasterScene => {
    if (currentScene) return currentScene;
    const id = stableId('scene', `${documentId}:${lineIndex}:${title}`);
    currentScene = { id, title, sourceSpanIds: [], shotIds: [], revision: 1 };
    scenes.push(currentScene);
    return currentScene;
  };
  const ensureShot = (lineIndex: number, title?: string): ScriptMasterShot & { bodyLines: string[] } => {
    if (currentShot) return currentShot;
    const scene = ensureScene(lineIndex);
    const id = stableId('shot', `${documentId}:${lineIndex}:${title || scene.title}`);
    currentShot = {
      id,
      sceneId: scene.id,
      title: title || `镜头 ${shotDrafts.length + 1}`,
      purpose: '',
      visualDescription: '',
      action: '',
      shotSize: '中景',
      camera: '固定机位',
      transitionIn: shotDrafts.length ? '硬切' : '开场',
      transitionOut: '硬切',
      transitionInFrames: 0,
      range: rationalRange(0, 0, project.fps),
      sourceSpanIds: [],
      characterIds: [],
      bindingIds: [],
      mustInclude: [],
      mustAvoid: [],
      locked: false,
      revision: 1,
      bodyLines: [],
    };
    shotDrafts.push(currentShot);
    scene.shotIds.push(id);
    return currentShot;
  };
  const ensureCharacter = (nameInput: string, spanId: string): ScriptMasterEntity => {
    const identity = scriptMasterSpeakerIdentity(nameInput);
    const { key, name } = identity;
    const existing = entityByName.get(key);
    if (existing) {
      if (!existing.sourceSpanIds.includes(spanId)) existing.sourceSpanIds.push(spanId);
      identity.aliases.forEach((alias) => {
        if (!existing.aliases.includes(alias)) existing.aliases.push(alias);
      });
      return existing;
    }
    const entity: ScriptMasterEntity = {
      id: stableId('character', `${documentId}:${key}`),
      kind: 'character',
      name,
      aliases: identity.aliases,
      sourceSpanIds: [spanId],
      confidence: 1,
      status: 'source-backed',
      revision: 1,
    };
    entityByName.set(key, entity);
    entities.push(entity);
    return entity;
  };

  sourceLines.forEach((line, index) => {
    if (consumedLineIndexes.has(index)) return;
    const trimmed = line.text.trim();
    if (!trimmed) return;
    const sceneTitle = sceneHeading(trimmed);
    if (sceneTitle) {
      const span = sourceSpan(documentId, hash, line, 'scene');
      spans.push(span);
      const scene: ScriptMasterScene = {
        id: stableId('scene', `${documentId}:${line.line}:${sceneTitle}`),
        title: sceneTitle,
        sourceSpanIds: [span.id],
        shotIds: [],
        revision: 1,
      };
      scenes.push(scene);
      currentScene = scene;
      currentShot = null;
      return;
    }
    const shotTitle = shotHeading(trimmed);
    if (shotTitle) {
      const span = sourceSpan(documentId, hash, line, 'shot');
      spans.push(span);
      currentShot = null;
      const shot = ensureShot(line.line, shotTitle);
      shot.sourceSpanIds.push(span.id);
      return;
    }
    const shot = ensureShot(line.line);
    const audio = explicitAudio(trimmed);
    if (audio) {
      const span = sourceSpan(documentId, hash, line, 'audio');
      spans.push(span);
      shot.sourceSpanIds.push(span.id);
      audioDrafts.push({
        id: stableId('audio-event', `${documentId}:${line.line}:${audio.role}`),
        shotId: shot.id,
        role: audio.role,
        description: audio.description,
        assetId: null,
        sourceSpanIds: [span.id],
        volume: 1,
        fadeInFrames: 0,
        fadeOutFrames: 0,
        duckDialogue: audio.role === 'music',
        revision: 1,
        order: index,
      });
      return;
    }
    const dialogue = explicitDialogue(trimmed);
    if (dialogue) {
      const span = sourceSpan(documentId, hash, line, 'dialogue');
      spans.push(span);
      shot.sourceSpanIds.push(span.id);
      const speaker = ensureCharacter(dialogue.speaker, span.id);
      if (!shot.characterIds.includes(speaker.id)) shot.characterIds.push(speaker.id);
      dialogueDrafts.push({
        id: stableId('dialogue', `${documentId}:${line.line}:${dialogue.speaker}:${dialogue.text}`),
        shotId: shot.id,
        speakerId: speaker.id,
        speakerName: speaker.name,
        text: dialogue.text,
        emotion: '',
        sourceSpanIds: [span.id],
        allowAcrossShots: false,
        revision: 1,
        order: index,
      });
      return;
    }
    if (looksLikeFountainSpeaker(trimmed)) {
      const next = sourceLines[index + 1]?.text.trim();
      if (next && !sceneHeading(next) && !shotHeading(next) && !explicitAudio(next) && !explicitDialogue(next)) {
        const span = sourceSpan(documentId, hash, line, 'speaker');
        const dialogueSpan = sourceSpan(documentId, hash, sourceLines[index + 1], 'dialogue-body');
        spans.push(span, dialogueSpan);
        shot.sourceSpanIds.push(span.id, dialogueSpan.id);
        const speaker = ensureCharacter(trimmed, span.id);
        if (!shot.characterIds.includes(speaker.id)) shot.characterIds.push(speaker.id);
        dialogueDrafts.push({
          id: stableId('dialogue', `${documentId}:${line.line}:${trimmed}:${next}`),
          shotId: shot.id,
          speakerId: speaker.id,
          speakerName: speaker.name,
          text: next,
          emotion: '',
          sourceSpanIds: [span.id, dialogueSpan.id],
          allowAcrossShots: false,
          revision: 1,
          order: index,
        });
        consumedLineIndexes.add(index + 1);
        return;
      }
    }
    const span = sourceSpan(documentId, hash, line, 'body');
    spans.push(span);
    shot.sourceSpanIds.push(span.id);
    shot.bodyLines.push(trimmed);
  });

  let cursor = 0;
  const shots = shotDrafts.map((shot) => {
    const dialogueCharacters = dialogueDrafts.filter((line) => line.shotId === shot.id).reduce((sum, line) => sum + line.text.length, 0);
    const durationFrames = Math.max(project.fps * 5, Math.ceil((dialogueCharacters / 4 + (dialogueCharacters ? 1 : 0)) * project.fps));
    const range = rationalRange(cursor, cursor + durationFrames, project.fps);
    cursor += durationFrames;
    const { bodyLines, ...shotFields } = shot;
    return {
      ...shotFields,
      visualDescription: bodyLines.join('\n'),
      range,
    };
  });
  const shotById = new Map(shots.map((shot) => [shot.id, shot]));
  const dialogueLines: ScriptMasterDialogueLine[] = [];
  for (const shot of shots) {
    const lines = dialogueDrafts.filter((line) => line.shotId === shot.id).sort((left, right) => left.order - right.order);
    const shotStart = shot.range.start.value;
    const shotEnd = shot.range.end.value;
    let dialogueCursor = shotStart;
    lines.forEach((line, index) => {
      const desired = Math.max(project.fps, Math.ceil((line.text.length / 4 + 0.5) * project.fps));
      const remaining = Math.max(1, shotEnd - dialogueCursor);
      const duration = index === lines.length - 1 ? remaining : Math.min(desired, remaining);
      dialogueLines.push({ ...line, range: rationalRange(dialogueCursor, dialogueCursor + duration, project.fps) });
      dialogueCursor += duration;
    });
  }
  const audioEvents: ScriptMasterAudioEvent[] = audioDrafts.map((event) => {
    const shot = shotById.get(event.shotId);
    return {
      ...event,
      range: shot ? cloneRange(shot.range) : rationalRange(0, project.fps * 5, project.fps),
    };
  });
  const sourceDocument: ScriptMasterSourceDocument = {
    id: documentId,
    name: cleanString(options.name, 200) || '导入剧本',
    format: options.format === 'markdown' || options.format === 'fountain' || options.format === 'json' ? options.format : 'text',
    language: cleanString(options.language, 40) || project.language,
    content,
    contentHash: hash,
    importedAt,
    revision: previousDocument ? previousDocument.revision + (previousDocument.contentHash === hash ? 0 : 1) : 1,
    spans,
  };
  const reconciled = options.replace === false ? {
    entities,
    scenes,
    shots,
    dialogueLines,
    audioEvents,
    changedShotIds: shots.map((shot) => shot.id),
    lockedConflictItems: [] as ScriptMasterProject['unresolvedItems'],
  } : reconcileImportedIdentity(project, { entities, scenes, shots, dialogueLines, audioEvents });
  const imported = markRevision({
    ...project,
    title: project.title === '未命名剧本' ? (cleanString(options.name, 160).replace(/\.[^.]+$/, '') || project.title) : project.title,
    sourceDocuments: options.replace === false ? [...project.sourceDocuments, sourceDocument] : [sourceDocument],
    entities: reconciled.entities,
    scenes: reconciled.scenes,
    shots: reconciled.shots,
    dialogueLines: reconciled.dialogueLines,
    audioEvents: reconciled.audioEvents,
    unresolvedItems: reconciled.lockedConflictItems,
    dependencyGraph: Object.fromEntries(reconciled.shots.map((shot) => [shot.id, [
      ...shot.sourceSpanIds,
      ...reconciled.dialogueLines.filter((line) => line.shotId === shot.id).flatMap((line) => line.sourceSpanIds),
      ...reconciled.audioEvents.filter((event) => event.shotId === shot.id).flatMap((event) => event.sourceSpanIds),
    ]])),
    targetDurationFrames: cursor,
  }, '确定性导入剧本原文（未调用模型）');
  return rebuildScriptMasterTimeline(imported);
}

function timelineRangeForBinding(binding: ScriptMasterBinding, project: ScriptMasterProject): RationalTimeRange {
  if (binding.scope === 'custom' && binding.range) return cloneRange(binding.range);
  if (binding.scope === 'shot') {
    const matching = project.shots.filter((shot) => binding.shotIds.includes(shot.id));
    if (matching.length) return rationalRange(
      Math.min(...matching.map((shot) => shot.range.start.value)),
      Math.max(...matching.map((shot) => shot.range.end.value)),
      project.fps,
    );
  }
  if (binding.scope === 'scene' && binding.sceneId) {
    const matching = project.shots.filter((shot) => shot.sceneId === binding.sceneId);
    if (matching.length) return rationalRange(
      Math.min(...matching.map((shot) => shot.range.start.value)),
      Math.max(...matching.map((shot) => shot.range.end.value)),
      project.fps,
    );
  }
  return rationalRange(0, project.targetDurationFrames, project.fps);
}

export function rebuildScriptMasterTimeline(projectInput: ScriptMasterProject): ScriptMasterProject {
  const project = sanitizeScriptMasterProject(projectInput);
  const previousTrackById = new Map(project.timeline.tracks.map((track) => [track.id, track]));
  const tracks = baseTracks();
  const trackIds = new Set(tracks.map((track) => track.id));
  const ensureTrack = (track: ScriptMasterTimelineTrack) => {
    if (!trackIds.has(track.id)) {
      trackIds.add(track.id);
      tracks.push(track);
    }
  };
  const items: ScriptMasterTimelineItem[] = project.shots.map((shot) => ({
    id: `timeline-shot-${shot.id}`,
    trackId: 'track-picture-main',
    kind: 'shot',
    range: cloneRange(shot.range),
    shotId: shot.id,
    assetId: null,
    bindingId: null,
    dialogueLineId: null,
    audioEventId: null,
    label: shot.title,
    locked: shot.locked,
    revision: shot.revision,
  }));
  project.shots.slice(1).forEach((shot) => {
    items.push({
      id: `timeline-transition-${shot.id}`,
      trackId: 'track-transition-main',
      kind: 'transition',
      range: rationalRange(Math.max(0, shot.range.start.value - finiteInteger(shot.transitionInFrames, 0, 0)), shot.range.start.value, project.fps),
      shotId: shot.id,
      assetId: null,
      bindingId: null,
      dialogueLineId: null,
      audioEventId: null,
      label: shot.transitionIn || '硬切',
      locked: shot.locked,
      revision: shot.revision,
    });
  });
  project.dialogueLines.forEach((line) => {
    const role = line.speakerId || 'unresolved';
    const trackId = `track-dialogue-${role}`;
    ensureTrack({
      id: trackId,
      group: 'dialogue',
      name: `台词 · ${line.speakerName || '说话人未定'}`,
      role,
      order: 300 + tracks.filter((track) => track.group === 'dialogue').length,
      locked: false,
      hidden: false,
      muted: false,
      assetId: null,
    });
    items.push({
      id: `timeline-dialogue-${line.id}`,
      trackId,
      kind: 'dialogue',
      range: cloneRange(line.range),
      shotId: line.shotId,
      assetId: null,
      bindingId: null,
      dialogueLineId: line.id,
      audioEventId: null,
      label: `${line.speakerName || '待定'}：${line.text}`,
      locked: false,
      revision: line.revision,
    });
  });
  project.audioEvents.forEach((event) => {
    const trackId = `track-sound-${event.role}`;
    ensureTrack({
      id: trackId,
      group: 'sound',
      name: `声音 · ${audioRoleTrackName(event.role)}`,
      role: event.role,
      order: 500 + ['dialogue', 'voiceover', 'music', 'ambience', 'sfx'].indexOf(event.role),
      locked: false,
      hidden: false,
      muted: false,
      assetId: null,
    });
    items.push({
      id: `timeline-audio-${event.id}`,
      trackId,
      kind: 'audio',
      range: cloneRange(event.range),
      shotId: event.shotId,
      assetId: event.assetId,
      bindingId: null,
      dialogueLineId: null,
      audioEventId: event.id,
      label: event.description,
      locked: false,
      revision: event.revision,
    });
  });
  project.bindings.forEach((binding) => {
    const asset = project.assets.find((item) => item.id === binding.assetId);
    if (!asset) return;
    const group: ScriptMasterTrackGroup = tracks.find((track) => track.id === binding.trackId)?.group || (asset.mediaKind === 'audio' ? 'sound' : 'reference');
    ensureTrack({
      id: binding.trackId,
      group,
      name: `${group === 'reference' ? '参考' : '声音'} · ${asset.alias} ${asset.name}`,
      role: binding.role,
      order: group === 'reference' ? 200 + tracks.filter((track) => track.group === 'reference').length : 600 + tracks.filter((track) => track.group === 'sound').length,
      locked: binding.locked,
      hidden: false,
      muted: false,
      assetId: asset.id,
    });
    items.push({
      id: `timeline-binding-${binding.id}`,
      trackId: binding.trackId,
      kind: asset.mediaKind === 'audio' && group === 'sound' ? 'audio' : 'reference',
      range: timelineRangeForBinding(binding, project),
      shotId: binding.scope === 'shot' && binding.shotIds.length === 1 ? binding.shotIds[0] : null,
      assetId: asset.id,
      bindingId: binding.id,
      dialogueLineId: null,
      audioEventId: null,
      label: `${asset.alias} ${asset.name}`,
      locked: binding.locked,
      revision: binding.revision,
    });
  });
  const timelineTracks = tracks
    .map((track) => {
      const previous = previousTrackById.get(track.id);
      return previous ? {
        ...track,
        locked: previous.locked,
        hidden: previous.hidden,
        muted: previous.muted,
      } : track;
    })
    .sort((left, right) => left.order - right.order);
  const itemIds = new Set(items.map((item) => item.id));
  return {
    ...project,
    timeline: {
      ...project.timeline,
      tracks: timelineTracks,
      items,
      selectedItemIds: project.timeline.selectedItemIds.filter((itemId) => itemIds.has(itemId)),
      playhead: rationalTime(Math.min(project.timeline.playhead.value, project.targetDurationFrames), project.fps),
    },
  };
}

export function addScriptMasterAsset(
  projectInput: ScriptMasterProject,
  input: AddScriptMasterAssetInput,
): ScriptMasterProject {
  let project = sanitizeScriptMasterProject(projectInput);
  const kind = ASSET_KINDS.has(input.kind) ? input.kind : 'image';
  const mediaKind = mediaKindForAssetKind(kind);
  const sourceKey = cleanString(input.sourceKey, 1_000);
  const url = cleanString(input.url, 100_000);
  const duplicate = project.assets.find((asset) => sourceKey ? asset.sourceKey === sourceKey : Boolean(url) && asset.url === url && asset.mediaKind === mediaKind);
  if (duplicate) return project;
  const counter = project.aliasCounters[mediaKind];
  const alias = `@${aliasPrefix(mediaKind)}${counter}`;
  const createdAt = nowIso();
  const asset: ScriptMasterAsset = {
    id: cleanString(input.id, 160) || createId('asset'),
    kind,
    mediaKind,
    name: cleanString(input.name, 200) || `${mediaKind === 'image' ? '参考图' : mediaKind === 'video' ? '参考视频' : '音频'} ${counter}`,
    alias,
    url,
    source: input.source || (url ? 'local' : 'unresolved'),
    sourceKey,
    revision: 1,
    contentHash: cleanString(input.contentHash, 160) || stableHash(url || `${createdAt}:${alias}`),
    locked: false,
    durationFrames: input.durationFrames == null ? null : finiteInteger(input.durationFrames, 0, 0),
    width: input.width == null ? null : finiteInteger(input.width, 0, 0),
    height: input.height == null ? null : finiteInteger(input.height, 0, 0),
    mime: cleanString(input.mime, 160),
    hasAudio: typeof input.hasAudio === 'boolean' ? input.hasAudio : null,
    waveformPeaks: Array.isArray(input.waveformPeaks)
      ? input.waveformPeaks.slice(0, 128).map((peak) => Math.max(0, Math.min(1, Number(peak) || 0)))
      : [],
    probeStatus: input.probeStatus === 'probing' || input.probeStatus === 'ready' || input.probeStatus === 'error' ? input.probeStatus : 'unprobed',
    probeError: cleanString(input.probeError, 2_000),
    lastProbedAt: input.probeStatus === 'ready' || input.probeStatus === 'error' ? createdAt : null,
    createdAt,
    updatedAt: createdAt,
  };
  const group = input.trackGroup || (mediaKind === 'audio' ? 'sound' : 'reference');
  const trackId = `track-${group}-${asset.id}`;
  const binding: ScriptMasterBinding = {
    id: createId('binding'),
    assetId: asset.id,
    alias,
    role: cleanString(input.role, 160) || kind,
    scope: input.scope === 'scene' || input.scope === 'shot' || input.scope === 'custom' ? input.scope : 'project',
    sceneId: cleanString(input.sceneId, 160) || null,
    shotIds: cleanStringArray(input.shotIds),
    range: input.range ? sanitizeTimeRange(input.range, project.fps) : null,
    trackId,
    required: input.required !== false,
    locked: false,
    assetRevision: asset.revision,
    contentHash: asset.contentHash,
    provenance: input.source === 'upstream' ? 'upstream' : input.source === 'resource-library' ? 'imported' : 'user',
    revision: 1,
  };
  project = markRevision({
    ...project,
    assets: [...project.assets, asset],
    bindings: [...project.bindings, binding],
    aliasCounters: { ...project.aliasCounters, [mediaKind]: counter + 1 },
    lineage: [...project.lineage, { id: createId('lineage'), kind: 'asset-binding', sourceId: asset.id, targetId: binding.id, revision: project.revision + 1 }],
  }, `添加素材 ${alias}`);
  return rebuildScriptMasterTimeline(project);
}

export function removeScriptMasterAsset(projectInput: ScriptMasterProject, assetId: string): ScriptMasterProject {
  let project = sanitizeScriptMasterProject(projectInput);
  const asset = project.assets.find((item) => item.id === assetId);
  if (!asset || asset.locked) return project;
  project = markRevision({
    ...project,
    assets: project.assets.filter((item) => item.id !== assetId),
    bindings: project.bindings.filter((binding) => binding.assetId !== assetId),
    audioEvents: project.audioEvents.map((event) => event.assetId === assetId ? { ...event, assetId: null, revision: event.revision + 1 } : event),
  }, `删除素材 ${asset.alias}（保留别名计数器）`);
  return rebuildScriptMasterTimeline(project);
}

export function patchScriptMasterBinding(
  projectInput: ScriptMasterProject,
  bindingId: string,
  patch: Partial<Pick<ScriptMasterBinding, 'scope' | 'sceneId' | 'shotIds' | 'range' | 'role' | 'required' | 'locked'>>,
): ScriptMasterProject {
  let project = sanitizeScriptMasterProject(projectInput);
  const current = project.bindings.find((binding) => binding.id === bindingId);
  if (!current || current.locked && patch.locked !== false) return project;
  project = markRevision({
    ...project,
    bindings: project.bindings.map((binding) => binding.id === bindingId ? {
      ...binding,
      ...patch,
      shotIds: patch.shotIds ? cleanStringArray(patch.shotIds) : binding.shotIds,
      sceneId: patch.sceneId === undefined ? binding.sceneId : cleanString(patch.sceneId, 160) || null,
      range: patch.range === undefined ? binding.range : patch.range ? sanitizeTimeRange(patch.range, project.fps) : null,
      revision: binding.revision + 1,
    } : binding),
  }, `更新引用作用域 ${current.alias}`);
  return rebuildScriptMasterTimeline(project);
}

function reflowShots(shotsInput: ScriptMasterShot[], fps: number): ScriptMasterShot[] {
  let cursor = 0;
  return shotsInput.map((shot) => {
    const duration = Math.max(1, rangeDurationFrames(shot.range, fps));
    const range = rationalRange(cursor, cursor + duration, fps);
    cursor += duration;
    return { ...shot, range };
  });
}

function retimeRangeWithShot(
  range: RationalTimeRange,
  previousShot: ScriptMasterShot,
  nextShot: ScriptMasterShot,
  fps: number,
  clampToShot: boolean,
): RationalTimeRange {
  const delta = nextShot.range.start.value - previousShot.range.start.value;
  let start = range.start.value + delta;
  let end = range.end.value + delta;
  if (clampToShot) {
    start = Math.max(nextShot.range.start.value, Math.min(nextShot.range.end.value - 1, start));
    end = Math.max(start + 1, Math.min(nextShot.range.end.value, end));
  }
  return rationalRange(start, Math.max(start, end), fps);
}

function applyScriptMasterShotLayout(
  project: ScriptMasterProject,
  shotsInput: ScriptMasterShot[],
  reason: string,
  overrides: Partial<Pick<ScriptMasterProject, 'dialogueLines' | 'audioEvents' | 'bindings'>> = {},
): ScriptMasterProject {
  const shots = reflowShots(shotsInput, project.fps);
  const previousShotById = new Map(project.shots.map((shot) => [shot.id, shot]));
  const nextShotById = new Map(shots.map((shot) => [shot.id, shot]));
  const dialogueLines = (overrides.dialogueLines || project.dialogueLines).map((line) => {
    const previousShot = previousShotById.get(line.shotId);
    const nextShot = nextShotById.get(line.shotId);
    if (!previousShot || !nextShot) return line;
    const range = retimeRangeWithShot(line.range, previousShot, nextShot, project.fps, !line.allowAcrossShots);
    return range.start.value === line.range.start.value && range.end.value === line.range.end.value
      ? line
      : { ...line, range, revision: line.revision + 1 };
  });
  const audioEvents = (overrides.audioEvents || project.audioEvents).map((event) => {
    const previousShot = previousShotById.get(event.shotId);
    const nextShot = nextShotById.get(event.shotId);
    if (!previousShot || !nextShot) return event;
    const range = retimeRangeWithShot(event.range, previousShot, nextShot, project.fps, false);
    return range.start.value === event.range.start.value && range.end.value === event.range.end.value
      ? event
      : { ...event, range, revision: event.revision + 1 };
  });
  const scenes = project.scenes.map((scene) => {
    const shotIds = shots.filter((shot) => shot.sceneId === scene.id).map((shot) => shot.id);
    return shotIds.join('\u0000') === scene.shotIds.join('\u0000')
      ? scene
      : { ...scene, shotIds, revision: scene.revision + 1 };
  });
  const next = markRevision({
    ...project,
    shots,
    scenes,
    dialogueLines,
    audioEvents,
    bindings: overrides.bindings || project.bindings,
    targetDurationFrames: shots.at(-1)?.range.end.value || 0,
  }, reason);
  return rebuildScriptMasterTimeline(next);
}

export function patchScriptMasterShot(
  projectInput: ScriptMasterProject,
  shotId: string,
  patch: Partial<Omit<ScriptMasterShot, 'id' | 'sceneId' | 'range'>> & { durationFrames?: number },
): ScriptMasterProject {
  let project = sanitizeScriptMasterProject(projectInput);
  const current = project.shots.find((shot) => shot.id === shotId);
  if (!current || current.locked && patch.locked !== false) return project;
  const shots = project.shots.map((shot) => {
    if (shot.id !== shotId) return shot;
    const duration = patch.durationFrames == null ? rangeDurationFrames(shot.range, project.fps) : finiteInteger(patch.durationFrames, project.fps, 1);
    return {
      ...shot,
      ...patch,
      range: rationalRange(shot.range.start.value, shot.range.start.value + duration, project.fps),
      sourceSpanIds: patch.sourceSpanIds ? cleanStringArray(patch.sourceSpanIds) : shot.sourceSpanIds,
      characterIds: patch.characterIds ? cleanStringArray(patch.characterIds) : shot.characterIds,
      bindingIds: patch.bindingIds ? cleanStringArray(patch.bindingIds) : shot.bindingIds,
      mustInclude: patch.mustInclude ? cleanStringArray(patch.mustInclude) : shot.mustInclude,
      mustAvoid: patch.mustAvoid ? cleanStringArray(patch.mustAvoid) : shot.mustAvoid,
      revision: shot.revision + 1,
    };
  });
  return applyScriptMasterShotLayout(project, shots, `更新镜头 ${current.title}`);
}

export function patchScriptMasterProjectSettings(
  projectInput: ScriptMasterProject,
  patch: Partial<Pick<ScriptMasterProject, 'title' | 'domain' | 'language' | 'aspectRatio' | 'strictMode'>>,
): ScriptMasterProject {
  const project = sanitizeScriptMasterProject(projectInput);
  return markRevision({
    ...project,
    ...patch,
    title: patch.title === undefined ? project.title : cleanString(patch.title, 160) || project.title,
    domain: patch.domain && DOMAINS.has(patch.domain) ? patch.domain : project.domain,
    language: patch.language === undefined ? project.language : cleanString(patch.language, 40) || project.language,
    aspectRatio: patch.aspectRatio === undefined ? project.aspectRatio : cleanString(patch.aspectRatio, 24) || project.aspectRatio,
    strictMode: patch.strictMode === undefined ? project.strictMode : patch.strictMode !== false,
  }, '更新剧本大师全局设定');
}

export function patchScriptMasterProviderSelection(
  projectInput: ScriptMasterProject,
  kind: keyof ScriptMasterProject['providerSelections'],
  selectionInput: Partial<ScriptMasterProviderSelection>,
): ScriptMasterProject {
  const project = sanitizeScriptMasterProject(projectInput);
  const current = project.providerSelections[kind];
  const selection: ScriptMasterProviderSelection = {
    provider: cleanString(selectionInput.provider, 160),
    model: cleanString(selectionInput.model, 240),
    version: cleanString(selectionInput.version, 80),
  };
  if (JSON.stringify(current) === JSON.stringify(selection)) return project;
  return markRevision({
    ...project,
    providerSelections: { ...project.providerSelections, [kind]: selection },
  }, `更新 ${kind} 模型选择`);
}

export function selectScriptMasterCompileTarget(projectInput: ScriptMasterProject, targetId: string): ScriptMasterProject {
  const project = sanitizeScriptMasterProject(projectInput);
  const target = project.compileTargets.find((item) => item.id === targetId)
    || SCRIPT_MASTER_TARGET_CAPABILITIES.find((item) => item.id === targetId);
  if (!target || project.compileTargets[0]?.id === target.id) return project;
  return markRevision({
    ...project,
    compileTargets: [target, ...project.compileTargets.filter((item) => item.id !== target.id)],
  }, `切换编译目标 ${target.label}`);
}

export function patchScriptMasterAssetMetadata(
  projectInput: ScriptMasterProject,
  assetId: string,
  patch: Partial<Pick<ScriptMasterAsset, 'durationFrames' | 'width' | 'height' | 'contentHash' | 'url' | 'mime' | 'hasAudio' | 'waveformPeaks' | 'probeStatus' | 'probeError'>>,
): ScriptMasterProject {
  const project = sanitizeScriptMasterProject(projectInput);
  const asset = project.assets.find((item) => item.id === assetId);
  if (!asset || asset.locked) return project;
  const nextAsset: ScriptMasterAsset = {
    ...asset,
    ...(patch.durationFrames === undefined ? {} : { durationFrames: patch.durationFrames == null ? null : finiteInteger(patch.durationFrames, 0, 0) }),
    ...(patch.width === undefined ? {} : { width: patch.width == null ? null : finiteInteger(patch.width, 0, 0) }),
    ...(patch.height === undefined ? {} : { height: patch.height == null ? null : finiteInteger(patch.height, 0, 0) }),
    ...(patch.contentHash === undefined ? {} : { contentHash: cleanString(patch.contentHash, 160) || asset.contentHash }),
    ...(patch.url === undefined ? {} : { url: cleanString(patch.url, 100_000) }),
    ...(patch.mime === undefined ? {} : { mime: cleanString(patch.mime, 160) }),
    ...(patch.hasAudio === undefined ? {} : { hasAudio: typeof patch.hasAudio === 'boolean' ? patch.hasAudio : null }),
    ...(patch.waveformPeaks === undefined ? {} : {
      waveformPeaks: Array.isArray(patch.waveformPeaks)
        ? patch.waveformPeaks.slice(0, 128).map((peak) => Math.max(0, Math.min(1, Number(peak) || 0)))
        : [],
    }),
    ...(patch.probeStatus === undefined ? {} : { probeStatus: patch.probeStatus }),
    ...(patch.probeError === undefined ? {} : { probeError: cleanString(patch.probeError, 2_000) }),
    lastProbedAt: patch.probeStatus === 'ready' || patch.probeStatus === 'error' ? nowIso() : asset.lastProbedAt,
    revision: asset.revision + 1,
    updatedAt: nowIso(),
  };
  const next = markRevision({
    ...project,
    assets: project.assets.map((item) => item.id === assetId ? nextAsset : item),
    bindings: project.bindings.map((binding) => binding.assetId === assetId && !binding.locked ? {
      ...binding,
      assetRevision: nextAsset.revision,
      contentHash: nextAsset.contentHash,
      revision: binding.revision + 1,
    } : binding),
  }, `更新素材探测信息 ${asset.alias}`);
  return rebuildScriptMasterTimeline(next);
}

export function appendScriptMasterShot(projectInput: ScriptMasterProject, title = ''): ScriptMasterProject {
  let project = sanitizeScriptMasterProject(projectInput);
  let scenes = project.scenes;
  let scene = scenes.at(-1);
  if (!scene) {
    scene = { id: createId('scene'), title: '未分场', sourceSpanIds: [], shotIds: [], revision: 1 };
    scenes = [scene];
  }
  const id = createId('shot');
  const start = project.targetDurationFrames;
  const shot: ScriptMasterShot = {
    id,
    sceneId: scene.id,
    title: cleanString(title, 200) || `镜头 ${project.shots.length + 1}`,
    purpose: '',
    visualDescription: '',
    action: '',
    shotSize: '中景',
    camera: '固定机位',
    transitionIn: project.shots.length ? '硬切' : '开场',
    transitionOut: '硬切',
    transitionInFrames: 0,
    range: rationalRange(start, start + project.fps * 5, project.fps),
    sourceSpanIds: [],
    characterIds: [],
    bindingIds: [],
    mustInclude: [],
    mustAvoid: [],
    locked: false,
    revision: 1,
  };
  scenes = scenes.map((item) => item.id === scene?.id ? { ...item, shotIds: [...item.shotIds, id], revision: item.revision + 1 } : item);
  project = markRevision({
    ...project,
    scenes,
    shots: [...project.shots, shot],
    targetDurationFrames: shot.range.end.value,
  }, `新增镜头 ${shot.title}`);
  return rebuildScriptMasterTimeline(project);
}

export function duplicateScriptMasterShot(projectInput: ScriptMasterProject, shotId: string): ScriptMasterProject {
  let project = sanitizeScriptMasterProject(projectInput);
  const index = project.shots.findIndex((shot) => shot.id === shotId);
  if (index < 0) return project;
  const source = project.shots[index];
  const id = createId('shot');
  const copy: ScriptMasterShot = { ...source, id, title: `${source.title} 副本`, locked: false, revision: 1 };
  const shots = reflowShots([...project.shots.slice(0, index + 1), copy, ...project.shots.slice(index + 1)], project.fps);
  const copiedShot = shots.find((shot) => shot.id === id) || copy;
  const copyRange = (range: RationalTimeRange) => retimeRangeWithShot(range, source, copiedShot, project.fps, false);
  const dialogueLines = [
    ...project.dialogueLines,
    ...project.dialogueLines.filter((line) => line.shotId === source.id).map((line) => ({
      ...line,
      id: createId('dialogue'),
      shotId: id,
      range: copyRange(line.range),
      revision: 1,
    })),
  ];
  const audioEvents = [
    ...project.audioEvents,
    ...project.audioEvents.filter((event) => event.shotId === source.id).map((event) => ({
      ...event,
      id: createId('audio-event'),
      shotId: id,
      range: copyRange(event.range),
      revision: 1,
    })),
  ];
  const bindings = project.bindings.map((binding) => binding.scope === 'shot' && binding.shotIds.includes(source.id)
    ? { ...binding, shotIds: [...binding.shotIds, id], revision: binding.revision + 1 }
    : binding);
  return applyScriptMasterShotLayout(project, shots, `复制镜头 ${source.title}`, { dialogueLines, audioEvents, bindings });
}

export function removeScriptMasterShot(projectInput: ScriptMasterProject, shotId: string): ScriptMasterProject {
  let project = sanitizeScriptMasterProject(projectInput);
  const source = project.shots.find((shot) => shot.id === shotId);
  if (!source || source.locked) return project;
  const shots = project.shots.filter((shot) => shot.id !== shotId);
  const dialogueLines = project.dialogueLines.filter((line) => line.shotId !== shotId);
  const audioEvents = project.audioEvents.filter((event) => event.shotId !== shotId);
  const bindings = project.bindings.map((binding) => binding.scope === 'shot' && binding.shotIds.includes(shotId)
    ? { ...binding, shotIds: binding.shotIds.filter((id) => id !== shotId), revision: binding.revision + 1 }
    : binding);
  return applyScriptMasterShotLayout(project, shots, `删除镜头 ${source.title}`, { dialogueLines, audioEvents, bindings });
}

export function patchScriptMasterTimelineView(
  projectInput: ScriptMasterProject,
  patch: Partial<Pick<ScriptMasterTimeline, 'selectedItemIds' | 'playhead' | 'zoom' | 'snap'>>,
): ScriptMasterProject {
  const project = sanitizeScriptMasterProject(projectInput);
  const itemIds = new Set(project.timeline.items.map((item) => item.id));
  const selectedItemIds = patch.selectedItemIds === undefined
    ? project.timeline.selectedItemIds
    : cleanStringArray(patch.selectedItemIds).filter((itemId) => itemIds.has(itemId));
  const playhead = patch.playhead === undefined
    ? project.timeline.playhead
    : rationalTime(Math.min(project.targetDurationFrames, rationalTimeToFrames(patch.playhead, project.fps)), project.fps);
  return {
    ...project,
    timeline: {
      ...project.timeline,
      selectedItemIds,
      playhead,
      zoom: patch.zoom === undefined ? project.timeline.zoom : Math.max(0.25, Math.min(8, Number(patch.zoom) || 1)),
      snap: patch.snap === undefined ? project.timeline.snap : patch.snap !== false,
    },
  };
}

export function patchScriptMasterTimelineTrack(
  projectInput: ScriptMasterProject,
  trackId: string,
  patch: Partial<Pick<ScriptMasterTimelineTrack, 'locked' | 'hidden' | 'muted'>>,
): ScriptMasterProject {
  const project = sanitizeScriptMasterProject(projectInput);
  const track = project.timeline.tracks.find((item) => item.id === trackId);
  if (!track) return project;
  const next = markRevision({
    ...project,
    timeline: {
      ...project.timeline,
      tracks: project.timeline.tracks.map((item) => item.id === trackId ? { ...item, ...patch } : item),
    },
  }, `更新轨道 ${track.name}`);
  return rebuildScriptMasterTimeline(next);
}

function editableScriptMasterTimelineItem(project: ScriptMasterProject, item: ScriptMasterTimelineItem): boolean {
  const track = project.timeline.tracks.find((candidate) => candidate.id === item.trackId);
  return !item.locked && !track?.locked;
}

function shiftScriptMasterNonShotItems(
  projectInput: ScriptMasterProject,
  itemIdsInput: string[],
  deltaFramesInput: number,
): ScriptMasterProject {
  const project = sanitizeScriptMasterProject(projectInput);
  const itemIds = new Set(cleanStringArray(itemIdsInput));
  const items = project.timeline.items.filter((item) => itemIds.has(item.id) && item.kind !== 'shot' && item.kind !== 'transition' && editableScriptMasterTimelineItem(project, item));
  if (!items.length) return project;
  const requestedDelta = Math.round(Number(deltaFramesInput) || 0);
  const minStart = Math.min(...items.map((item) => item.range.start.value));
  const maxEnd = Math.max(...items.map((item) => item.range.end.value));
  const deltaFrames = Math.max(-minStart, Math.min(project.targetDurationFrames - maxEnd, requestedDelta));
  if (!deltaFrames) return project;
  const shiftedRangeByItemId = new Map(items.map((item) => [
    item.id,
    rationalRange(item.range.start.value + deltaFrames, item.range.end.value + deltaFrames, project.fps),
  ]));
  const shotAt = (frame: number) => project.shots.find((shot) => frame >= shot.range.start.value && frame < shot.range.end.value)?.id;
  const dialogueLines = project.dialogueLines.map((line) => {
    const range = shiftedRangeByItemId.get(`timeline-dialogue-${line.id}`);
    return range ? { ...line, range, shotId: shotAt(range.start.value) || line.shotId, allowAcrossShots: true, revision: line.revision + 1 } : line;
  });
  const audioEvents = project.audioEvents.map((event) => {
    const range = shiftedRangeByItemId.get(`timeline-audio-${event.id}`);
    return range ? { ...event, range, shotId: shotAt(range.start.value) || event.shotId, revision: event.revision + 1 } : event;
  });
  const bindings = project.bindings.map((binding) => {
    const range = shiftedRangeByItemId.get(`timeline-binding-${binding.id}`);
    return range ? {
      ...binding,
      scope: 'custom' as const,
      sceneId: null,
      shotIds: [],
      range,
      revision: binding.revision + 1,
    } : binding;
  });
  const next = markRevision({ ...project, dialogueLines, audioEvents, bindings }, `移动 ${items.length} 个时间线片段 ${deltaFrames} 帧`);
  return rebuildScriptMasterTimeline(next);
}

export function moveScriptMasterTimelineItems(
  projectInput: ScriptMasterProject,
  itemIdsInput: string[],
  deltaFramesInput: number,
): ScriptMasterProject {
  let project = sanitizeScriptMasterProject(projectInput);
  const itemIds = new Set(cleanStringArray(itemIdsInput));
  const selectedItems = project.timeline.items.filter((item) => itemIds.has(item.id) && editableScriptMasterTimelineItem(project, item));
  if (!selectedItems.length) return project;
  const deltaFrames = Math.round(Number(deltaFramesInput) || 0);
  const selectedShotIds = new Set(selectedItems.filter((item) => item.kind === 'shot' && item.shotId).map((item) => item.shotId as string));
  if (selectedShotIds.size && deltaFrames) {
    const selectedShots = project.shots.filter((shot) => selectedShotIds.has(shot.id));
    const remainingShots = project.shots.filter((shot) => !selectedShotIds.has(shot.id));
    const targetFrame = Math.max(0, Math.min(project.targetDurationFrames, Math.min(...selectedShots.map((shot) => shot.range.start.value)) + deltaFrames));
    let insertionIndex = remainingShots.findIndex((shot) => targetFrame < (shot.range.start.value + shot.range.end.value) / 2);
    if (insertionIndex < 0) insertionIndex = remainingShots.length;
    const reordered = [...remainingShots.slice(0, insertionIndex), ...selectedShots, ...remainingShots.slice(insertionIndex)];
    if (reordered.some((shot, index) => shot.id !== project.shots[index]?.id)) {
      project = applyScriptMasterShotLayout(project, reordered, `移动 ${selectedShots.length} 个镜头片段`);
    }
  }
  const selectedNonShotIds = selectedItems
    .filter((item) => item.kind !== 'shot' && item.kind !== 'transition' && (!item.shotId || !selectedShotIds.has(item.shotId)))
    .map((item) => item.id);
  return selectedNonShotIds.length ? shiftScriptMasterNonShotItems(project, selectedNonShotIds, deltaFrames) : project;
}

export function trimScriptMasterTimelineItem(
  projectInput: ScriptMasterProject,
  itemId: string,
  edge: 'start' | 'end',
  frameInput: number,
): ScriptMasterProject {
  const project = sanitizeScriptMasterProject(projectInput);
  const item = project.timeline.items.find((candidate) => candidate.id === itemId);
  if (!item || item.kind === 'transition' || !editableScriptMasterTimelineItem(project, item)) return project;
  const frame = Math.round(Number(frameInput) || 0);
  if (item.kind === 'shot' && item.shotId) {
    const index = project.shots.findIndex((shot) => shot.id === item.shotId);
    if (index < 0) return project;
    const shots = [...project.shots];
    const shot = shots[index];
    if (edge === 'end') {
      const end = Math.max(shot.range.start.value + 1, frame);
      shots[index] = { ...shot, range: rationalRange(shot.range.start.value, end, project.fps), revision: shot.revision + 1 };
    } else {
      if (index === 0) return project;
      const previous = shots[index - 1];
      const cut = Math.max(previous.range.start.value + 1, Math.min(shot.range.end.value - 1, frame));
      shots[index - 1] = { ...previous, range: rationalRange(previous.range.start.value, cut, project.fps), revision: previous.revision + 1 };
      shots[index] = { ...shot, range: rationalRange(cut, shot.range.end.value, project.fps), revision: shot.revision + 1 };
    }
    return applyScriptMasterShotLayout(project, shots, `修剪镜头 ${shot.title}`);
  }
  const start = edge === 'start' ? Math.max(0, Math.min(item.range.end.value - 1, frame)) : item.range.start.value;
  const end = edge === 'end' ? Math.max(item.range.start.value + 1, Math.min(project.targetDurationFrames, frame)) : item.range.end.value;
  const range = rationalRange(start, end, project.fps);
  const dialogueLines = project.dialogueLines.map((line) => item.dialogueLineId === line.id ? { ...line, range, allowAcrossShots: true, revision: line.revision + 1 } : line);
  const audioEvents = project.audioEvents.map((event) => item.audioEventId === event.id ? { ...event, range, revision: event.revision + 1 } : event);
  const bindings = project.bindings.map((binding) => item.bindingId === binding.id ? { ...binding, scope: 'custom' as const, sceneId: null, shotIds: [], range, revision: binding.revision + 1 } : binding);
  const next = markRevision({ ...project, dialogueLines, audioEvents, bindings }, `修剪时间线片段 ${item.label}`);
  return rebuildScriptMasterTimeline(next);
}

export function splitScriptMasterTimelineItem(
  projectInput: ScriptMasterProject,
  itemId: string,
  frameInput: number,
): ScriptMasterProject {
  const project = sanitizeScriptMasterProject(projectInput);
  const item = project.timeline.items.find((candidate) => candidate.id === itemId);
  if (!item || item.kind === 'transition' || item.kind === 'dialogue' || !editableScriptMasterTimelineItem(project, item)) return project;
  const frame = Math.round(Number(frameInput) || 0);
  if (frame <= item.range.start.value || frame >= item.range.end.value) return project;
  if (item.kind === 'shot' && item.shotId) {
    const index = project.shots.findIndex((shot) => shot.id === item.shotId);
    if (index < 0) return project;
    const source = project.shots[index];
    const id = createId('shot');
    const left = { ...source, range: rationalRange(source.range.start.value, frame, project.fps), revision: source.revision + 1 };
    const right: ScriptMasterShot = { ...source, id, title: `${source.title} · B`, range: rationalRange(frame, source.range.end.value, project.fps), locked: false, revision: 1 };
    const shots = [...project.shots.slice(0, index), left, right, ...project.shots.slice(index + 1)];
    const dialogueLines = project.dialogueLines.map((line) => {
      if (line.shotId !== source.id) return line;
      if (line.range.start.value >= frame) return { ...line, shotId: id, revision: line.revision + 1 };
      if (line.range.end.value > frame) return { ...line, allowAcrossShots: true, revision: line.revision + 1 };
      return line;
    });
    const audioEvents = project.audioEvents.map((event) => event.shotId === source.id && event.range.start.value >= frame
      ? { ...event, shotId: id, revision: event.revision + 1 }
      : event);
    const bindings = project.bindings.map((binding) => binding.scope === 'shot' && binding.shotIds.includes(source.id)
      ? { ...binding, shotIds: [...binding.shotIds, id], revision: binding.revision + 1 }
      : binding);
    return applyScriptMasterShotLayout(project, shots, `在 ${frame} 帧切分镜头 ${source.title}`, { dialogueLines, audioEvents, bindings });
  }
  if (item.audioEventId) {
    const source = project.audioEvents.find((event) => event.id === item.audioEventId);
    if (!source) return project;
    const next = markRevision({
      ...project,
      audioEvents: project.audioEvents.flatMap((event) => event.id === source.id ? [
        { ...event, range: rationalRange(event.range.start.value, frame, project.fps), revision: event.revision + 1 },
        { ...event, id: createId('audio-event'), range: rationalRange(frame, event.range.end.value, project.fps), revision: 1 },
      ] : [event]),
    }, `切分声音片段 ${item.label}`);
    return rebuildScriptMasterTimeline(next);
  }
  if (item.bindingId) {
    const source = project.bindings.find((binding) => binding.id === item.bindingId);
    if (!source || source.locked) return project;
    const next = markRevision({
      ...project,
      bindings: project.bindings.flatMap((binding) => binding.id === source.id ? [
        { ...binding, scope: 'custom', sceneId: null, shotIds: [], range: rationalRange(item.range.start.value, frame, project.fps), revision: binding.revision + 1 },
        { ...binding, id: createId('binding'), scope: 'custom', sceneId: null, shotIds: [], range: rationalRange(frame, item.range.end.value, project.fps), revision: 1 },
      ] : [binding]),
    }, `切分引用片段 ${item.label}`);
    return rebuildScriptMasterTimeline(next);
  }
  return project;
}

export function mergeScriptMasterTimelineItems(
  projectInput: ScriptMasterProject,
  itemIdsInput: string[],
): ScriptMasterProject {
  let project = sanitizeScriptMasterProject(projectInput);
  const itemIds = new Set(cleanStringArray(itemIdsInput));
  const selectedShotIds = new Set(project.timeline.items
    .filter((item) => itemIds.has(item.id) && item.kind === 'shot' && item.shotId)
    .map((item) => item.shotId!));
  if (selectedShotIds.size < 2) return project;
  const selected = project.shots
    .map((shot, index) => ({ shot, index }))
    .filter(({ shot }) => selectedShotIds.has(shot.id))
    .sort((left, right) => left.index - right.index);
  if (selected.some(({ shot }) => shot.locked)) return project;
  if (selected.some(({ shot }) => shot.sceneId !== selected[0].shot.sceneId)) return project;
  if (selected.some(({ index }, selectedIndex) => selectedIndex > 0 && index !== selected[selectedIndex - 1].index + 1)) return project;
  const first = selected[0].shot;
  const last = selected.at(-1)!.shot;
  const removedShotIds = new Set(selected.slice(1).map(({ shot }) => shot.id));
  const merged: ScriptMasterShot = {
    ...first,
    purpose: [...new Set(selected.map(({ shot }) => shot.purpose).filter(Boolean))].join('\n'),
    visualDescription: [...new Set(selected.map(({ shot }) => shot.visualDescription).filter(Boolean))].join('\n'),
    action: [...new Set(selected.map(({ shot }) => shot.action).filter(Boolean))].join('\n'),
    transitionOut: last.transitionOut,
    range: rationalRange(first.range.start.value, last.range.end.value, project.fps),
    sourceSpanIds: [...new Set(selected.flatMap(({ shot }) => shot.sourceSpanIds))],
    characterIds: [...new Set(selected.flatMap(({ shot }) => shot.characterIds))],
    bindingIds: [...new Set(selected.flatMap(({ shot }) => shot.bindingIds))],
    mustInclude: [...new Set(selected.flatMap(({ shot }) => shot.mustInclude))],
    mustAvoid: [...new Set(selected.flatMap(({ shot }) => shot.mustAvoid))],
    revision: first.revision + 1,
  };
  project = markRevision({
    ...project,
    shots: project.shots.flatMap((shot) => shot.id === first.id ? [merged] : removedShotIds.has(shot.id) ? [] : [shot]),
    scenes: project.scenes.map((scene) => ({
      ...scene,
      shotIds: scene.shotIds.filter((shotId) => !removedShotIds.has(shotId)),
      revision: scene.id === first.sceneId ? scene.revision + 1 : scene.revision,
    })),
    dialogueLines: project.dialogueLines.map((line) => removedShotIds.has(line.shotId)
      ? { ...line, shotId: first.id, revision: line.revision + 1 } : line),
    audioEvents: project.audioEvents.map((event) => removedShotIds.has(event.shotId)
      ? { ...event, shotId: first.id, revision: event.revision + 1 } : event),
    bindings: project.bindings.map((binding) => {
      if (!binding.shotIds.some((shotId) => removedShotIds.has(shotId))) return binding;
      return {
        ...binding,
        shotIds: [...new Set(binding.shotIds.map((shotId) => removedShotIds.has(shotId) ? first.id : shotId))],
        revision: binding.revision + 1,
      };
    }),
  }, `合并 ${selected.length} 个相邻镜头`);
  return rebuildScriptMasterTimeline(project);
}

export function duplicateScriptMasterTimelineItems(projectInput: ScriptMasterProject, itemIdsInput: string[]): ScriptMasterProject {
  let project = sanitizeScriptMasterProject(projectInput);
  const requested = cleanStringArray(itemIdsInput);
  for (const itemId of requested) {
    const item = project.timeline.items.find((candidate) => candidate.id === itemId);
    if (!item || !editableScriptMasterTimelineItem(project, item) || item.kind === 'transition') continue;
    if (item.kind === 'shot' && item.shotId) {
      project = duplicateScriptMasterShot(project, item.shotId);
      continue;
    }
    const duration = Math.max(1, rangeDurationFrames(item.range, project.fps));
    const start = Math.max(0, Math.min(project.targetDurationFrames - duration, item.range.start.value + Math.max(1, Math.min(project.fps, duration))));
    const range = rationalRange(start, start + duration, project.fps);
    if (item.dialogueLineId) {
      const source = project.dialogueLines.find((line) => line.id === item.dialogueLineId);
      if (source) project = rebuildScriptMasterTimeline(markRevision({ ...project, dialogueLines: [...project.dialogueLines, { ...source, id: createId('dialogue'), range, allowAcrossShots: true, revision: 1 }] }, `复制台词片段 ${item.label}`));
    } else if (item.audioEventId) {
      const source = project.audioEvents.find((event) => event.id === item.audioEventId);
      if (source) project = rebuildScriptMasterTimeline(markRevision({ ...project, audioEvents: [...project.audioEvents, { ...source, id: createId('audio-event'), range, revision: 1 }] }, `复制声音片段 ${item.label}`));
    } else if (item.bindingId) {
      const source = project.bindings.find((binding) => binding.id === item.bindingId);
      if (source && !source.locked) project = rebuildScriptMasterTimeline(markRevision({ ...project, bindings: [...project.bindings, { ...source, id: createId('binding'), scope: 'custom', sceneId: null, shotIds: [], range, locked: false, revision: 1 }] }, `复制引用片段 ${item.label}`));
    }
  }
  return project;
}

export function removeScriptMasterTimelineItems(projectInput: ScriptMasterProject, itemIdsInput: string[]): ScriptMasterProject {
  const project = sanitizeScriptMasterProject(projectInput);
  const requested = new Set(cleanStringArray(itemIdsInput));
  const items = project.timeline.items.filter((item) => requested.has(item.id) && editableScriptMasterTimelineItem(project, item));
  if (!items.length) return project;
  const shotIds = new Set(items.filter((item) => item.kind === 'shot' && item.shotId).map((item) => item.shotId as string));
  const dialogueIds = new Set(items.flatMap((item) => item.dialogueLineId ? [item.dialogueLineId] : []));
  const audioIds = new Set(items.flatMap((item) => item.audioEventId ? [item.audioEventId] : []));
  const bindingIds = new Set(items.flatMap((item) => item.bindingId ? [item.bindingId] : []));
  const shots = project.shots.filter((shot) => !shotIds.has(shot.id));
  const dialogueLines = project.dialogueLines.filter((line) => !shotIds.has(line.shotId) && !dialogueIds.has(line.id));
  const audioEvents = project.audioEvents.filter((event) => !shotIds.has(event.shotId) && !audioIds.has(event.id));
  const bindings = project.bindings
    .filter((binding) => !bindingIds.has(binding.id))
    .map((binding) => binding.scope === 'shot' && binding.shotIds.some((shotId) => shotIds.has(shotId))
      ? { ...binding, shotIds: binding.shotIds.filter((shotId) => !shotIds.has(shotId)), revision: binding.revision + 1 }
      : binding);
  if (shotIds.size) return applyScriptMasterShotLayout(project, shots, `删除 ${items.length} 个时间线片段`, { dialogueLines, audioEvents, bindings });
  const next = markRevision({ ...project, dialogueLines, audioEvents, bindings }, `删除 ${items.length} 个时间线片段`);
  return rebuildScriptMasterTimeline(next);
}

export function distributeScriptMasterShotDurations(projectInput: ScriptMasterProject): ScriptMasterProject {
  const project = sanitizeScriptMasterProject(projectInput);
  if (!project.shots.length || project.shots.some((shot) => shot.locked)) return project;
  const total = Math.max(project.shots.length, project.targetDurationFrames);
  const base = Math.floor(total / project.shots.length);
  let remainder = total - base * project.shots.length;
  const shots = project.shots.map((shot) => {
    const duration = base + (remainder-- > 0 ? 1 : 0);
    return { ...shot, range: rationalRange(shot.range.start.value, shot.range.start.value + duration, project.fps), revision: shot.revision + 1 };
  });
  return applyScriptMasterShotLayout(project, shots, '平均分配全部镜头时长');
}

export function restoreScriptMasterProjectSnapshot(
  currentInput: ScriptMasterProject,
  snapshotInput: ScriptMasterProject,
  reason: string,
): ScriptMasterProject {
  const current = sanitizeScriptMasterProject(currentInput);
  const snapshot = sanitizeScriptMasterProject(snapshotInput);
  const restored = markRevision({
    ...snapshot,
    projectId: current.projectId,
    createdAt: current.createdAt,
    updatedAt: current.updatedAt,
    revision: current.revision,
    revisions: current.revisions,
  }, cleanString(reason, 240) || '恢复剧本大师历史版本');
  return rebuildScriptMasterTimeline(restored);
}

function effectiveBindingsForNormalizedProject(
  project: ScriptMasterProject,
  shotInput: ScriptMasterShot,
): ScriptMasterBinding[] {
  const shotStart = shotInput.range.start.value;
  const shotEnd = shotInput.range.end.value;
  return project.bindings.filter((binding) => {
    if (binding.scope === 'project') return true;
    if (binding.scope === 'scene') return binding.sceneId === shotInput.sceneId;
    if (binding.scope === 'shot') return binding.shotIds.includes(shotInput.id);
    if (!binding.range) return false;
    return binding.range.start.value < shotEnd && binding.range.end.value > shotStart;
  }).sort((left, right) => {
    if (left.locked !== right.locked) return left.locked ? -1 : 1;
    const priority = SCOPE_PRIORITY[right.scope] - SCOPE_PRIORITY[left.scope];
    if (priority) return priority;
    return left.alias.localeCompare(right.alias, undefined, { numeric: true });
  });
}

export function effectiveScriptMasterBindingsForShot(
  projectInput: ScriptMasterProject,
  shotInput: ScriptMasterShot,
): ScriptMasterBinding[] {
  return effectiveBindingsForNormalizedProject(sanitizeScriptMasterProject(projectInput), shotInput);
}

export function createScriptMasterAnalysisRequest(
  projectInput: ScriptMasterProject,
  scopeShotIdsInput: string[] = [],
): { system: string; user: string; characterCount: number; scopeShotIds: string[] } {
  const project = sanitizeScriptMasterProject(projectInput);
  const requested = new Set(cleanStringArray(scopeShotIdsInput));
  const shots = requested.size ? project.shots.filter((shot) => requested.has(shot.id)) : project.shots;
  const spanById = new Map(project.sourceDocuments.flatMap((document) => document.spans).map((span) => [span.id, span]));
  const domainPack = project.domain === 'unconfirmed' ? null : SCRIPT_MASTER_DOMAIN_PACKS[project.domain];
  const sourceRows = shots.map((shot) => ({
    shotId: shot.id,
    locked: shot.locked,
    title: shot.title,
    source: shot.sourceSpanIds.flatMap((spanId) => spanById.get(spanId)?.text || []).join('\n'),
    dialogue: project.dialogueLines.filter((line) => line.shotId === shot.id).map((line) => ({
      speaker: line.speakerName,
      text: line.text,
      sourceSpanIds: line.sourceSpanIds,
    })),
    audio: project.audioEvents.filter((event) => event.shotId === shot.id).map((event) => ({ role: event.role, description: event.description })),
  }));
  const userPayload = JSON.stringify({
    project: { title: project.title, domain: project.domain, language: project.language, strictMode: project.strictMode },
    domainFocus: domainPack?.focusFields || [],
    shots: sourceRows,
  });
  return {
    characterCount: userPayload.length,
    scopeShotIds: shots.map((shot) => shot.id),
    system: [
      '你是剧本结构分析器，只能基于给定原文提出候选，不得改写事实或生成媒体。',
      '只输出一个 JSON 对象，禁止 Markdown 代码围栏和额外说明。',
      'locked=true 的镜头不得返回任何字段修改。没有来源的内容必须放入 unresolvedItems，不得自动确认。',
      'Schema: {domain?: narrative|ecommerce|advertising|music-video|documentary|tutorial, confidence:0..1, shots:[{shotId,confidence:0..1,fields:{title?,purpose?,visualDescription?,action?,shotSize?,camera?,transitionIn?,transitionOut?,mustInclude?:string[],mustAvoid?:string[]}}], unresolvedItems:[{kind,message,shotId?}]}',
    ].join('\n'),
    user: userPayload,
  };
}

function analysisJson(value: string): any {
  const text = cleanString(value, 1_000_000);
  const unfenced = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try {
    const parsed = JSON.parse(unfenced);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('模型结果必须是 JSON 对象');
    return parsed;
  } catch (error) {
    throw new Error(`LLM 分析结果 JSON 校验失败：${error instanceof Error ? error.message : '无法解析'}`);
  }
}

export function parseScriptMasterAnalysisCandidate(
  projectInput: ScriptMasterProject,
  responseText: string,
  selectionInput: ScriptMasterProviderSelection,
  scopeShotIdsInput: string[] = [],
): ScriptMasterAnalysisCandidate {
  const project = sanitizeScriptMasterProject(projectInput);
  const raw = analysisJson(responseText);
  const scope = new Set((scopeShotIdsInput.length ? cleanStringArray(scopeShotIdsInput) : project.shots.map((shot) => shot.id)));
  const knownShots = new Map(project.shots.filter((shot) => scope.has(shot.id)).map((shot) => [shot.id, shot]));
  if (!Array.isArray(raw.shots) || raw.shots.length > knownShots.size) throw new Error('LLM 分析 shots 数量无效');
  const seen = new Set<string>();
  const shotSuggestions: ScriptMasterAnalysisShotSuggestion[] = raw.shots.flatMap((suggestion: any) => {
    if (!suggestion || typeof suggestion !== 'object' || Array.isArray(suggestion)) throw new Error('LLM 分析镜头项无效');
    const shotId = cleanString(suggestion.shotId, 160);
    const shot = knownShots.get(shotId);
    if (!shot || seen.has(shotId)) throw new Error(`LLM 分析包含未知或重复镜头：${shotId || '(空)'}`);
    seen.add(shotId);
    if (shot.locked) {
      if (suggestion.fields && Object.keys(suggestion.fields).length) throw new Error(`LLM 分析试图修改锁定镜头：${shot.title}`);
      return [];
    }
    const fieldsRaw = suggestion.fields && typeof suggestion.fields === 'object' && !Array.isArray(suggestion.fields) ? suggestion.fields : {};
    const allowed = new Set(['title', 'purpose', 'visualDescription', 'action', 'shotSize', 'camera', 'transitionIn', 'transitionOut', 'mustInclude', 'mustAvoid']);
    if (Object.keys(fieldsRaw).some((key) => !allowed.has(key))) throw new Error(`LLM 分析镜头 ${shot.title} 含未允许字段`);
    const fields: ScriptMasterAnalysisShotSuggestion['fields'] = {};
    (['title', 'purpose', 'visualDescription', 'action', 'shotSize', 'camera', 'transitionIn', 'transitionOut'] as const).forEach((field) => {
      if (fieldsRaw[field] !== undefined) {
        if (typeof fieldsRaw[field] !== 'string') throw new Error(`LLM 分析字段 ${field} 必须是字符串`);
        const text = cleanString(fieldsRaw[field], field === 'visualDescription' ? 20_000 : 4_000);
        if (text) fields[field] = text;
      }
    });
    (['mustInclude', 'mustAvoid'] as const).forEach((field) => {
      if (fieldsRaw[field] !== undefined) {
        if (!Array.isArray(fieldsRaw[field]) || fieldsRaw[field].some((item: unknown) => typeof item !== 'string')) throw new Error(`LLM 分析字段 ${field} 必须是字符串数组`);
        fields[field] = cleanStringArray(fieldsRaw[field]);
      }
    });
    return Object.keys(fields).length ? [{
      shotId,
      confidence: Math.max(0, Math.min(1, Number(suggestion.confidence) || 0)),
      sourceSpanIds: shot.sourceSpanIds,
      fields,
    }] : [];
  });
  const proposedDomain: ScriptMasterDomain | null = DOMAINS.has(raw.domain) && raw.domain !== 'unconfirmed' ? raw.domain : null;
  const unresolvedItems = Array.isArray(raw.unresolvedItems) ? raw.unresolvedItems.slice(0, 200).map((item: any, index: number) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('LLM 分析 unresolvedItems 项无效');
    const shot = knownShots.get(cleanString(item.shotId, 160));
    return {
      id: stableId('analysis-unresolved', `${project.projectId}:${project.revision}:${index}:${cleanString(item.message, 2_000)}`),
      kind: cleanString(item.kind, 120) || 'analysis',
      message: cleanString(item.message, 2_000),
      sourceSpanIds: shot?.sourceSpanIds || [],
    };
  }).filter((item: { message: string }) => item.message) : [];
  const responseDigest = stableHash(JSON.stringify({ proposedDomain, shotSuggestions, unresolvedItems }));
  return {
    id: stableId('analysis-candidate', `${project.projectId}:${project.revision}:${responseDigest}`),
    status: 'candidate',
    provider: cleanString(selectionInput.provider, 160),
    model: cleanString(selectionInput.model, 240),
    version: cleanString(selectionInput.version, 80),
    scopeShotIds: [...scope],
    baseProjectRevision: project.revision,
    sourceDocumentIds: project.sourceDocuments.map((document) => document.id),
    sourceContentHashes: project.sourceDocuments.map((document) => document.contentHash),
    proposedDomain,
    confidence: Math.max(0, Math.min(1, Number(raw.confidence) || 0)),
    shotSuggestions,
    unresolvedItems,
    responseDigest,
    createdAt: nowIso(),
    adoptedAt: null,
    error: '',
  };
}

export function beginScriptMasterAnalysis(projectInput: ScriptMasterProject): ScriptMasterProject {
  const project = sanitizeScriptMasterProject(projectInput);
  return {
    ...project,
    analysis: {
      ...project.analysis,
      status: 'running',
      activeCandidateId: null,
      providerCalls: project.analysis.providerCalls + 1,
      lastError: '',
      lastRequestedAt: nowIso(),
    },
    updatedAt: nowIso(),
  };
}

export function recordScriptMasterAnalysisCandidate(
  projectInput: ScriptMasterProject,
  candidateInput: ScriptMasterAnalysisCandidate,
): ScriptMasterProject {
  const project = sanitizeScriptMasterProject(projectInput);
  const candidate = sanitizeAnalysisState({ candidates: [candidateInput] }).candidates[0];
  if (!candidate || candidate.baseProjectRevision !== project.revision
    || JSON.stringify(candidate.sourceContentHashes) !== JSON.stringify(project.sourceDocuments.map((document) => document.contentHash))) {
    throw new Error('LLM 分析候选基于旧项目或旧原文，请重新分析受影响范围');
  }
  return {
    ...project,
    analysis: {
      ...project.analysis,
      status: 'candidate',
      activeCandidateId: candidate.id,
      candidates: [...project.analysis.candidates.filter((item) => item.id !== candidate.id), candidate].slice(-30),
      lastError: '',
    },
    updatedAt: nowIso(),
  };
}

export function failScriptMasterAnalysis(projectInput: ScriptMasterProject, errorInput: string): ScriptMasterProject {
  const project = sanitizeScriptMasterProject(projectInput);
  return {
    ...project,
    analysis: { ...project.analysis, status: 'error', activeCandidateId: null, lastError: cleanString(errorInput, 2_000) || 'LLM 分析失败' },
    updatedAt: nowIso(),
  };
}

export function adoptScriptMasterAnalysisCandidate(projectInput: ScriptMasterProject, candidateId: string): ScriptMasterProject {
  const project = sanitizeScriptMasterProject(projectInput);
  const candidate = project.analysis.candidates.find((item) => item.id === candidateId);
  if (!candidate || candidate.status !== 'candidate' || candidate.baseProjectRevision !== project.revision) throw new Error('LLM 分析候选已失效，请重新分析');
  if (JSON.stringify(candidate.sourceContentHashes) !== JSON.stringify(project.sourceDocuments.map((document) => document.contentHash))) throw new Error('源剧本已变化，不能采纳旧分析候选');
  const suggestionByShotId = new Map(candidate.shotSuggestions.map((suggestion) => [suggestion.shotId, suggestion]));
  const nextBase = markRevision({
    ...project,
    domain: project.domain === 'unconfirmed' && candidate.proposedDomain ? candidate.proposedDomain : project.domain,
    shots: project.shots.map((shot) => {
      const suggestion = suggestionByShotId.get(shot.id);
      if (!suggestion || shot.locked) return shot;
      return { ...shot, ...suggestion.fields, revision: shot.revision + 1 };
    }),
    unresolvedItems: [...project.unresolvedItems, ...candidate.unresolvedItems].slice(-500),
    dependencyGraph: {
      ...project.dependencyGraph,
      ...Object.fromEntries(candidate.shotSuggestions.map((suggestion) => [suggestion.shotId, suggestion.sourceSpanIds])),
    },
  }, `采纳 LLM 分析候选 ${candidate.id}`);
  const adoptedAt = nowIso();
  return rebuildScriptMasterTimeline({
    ...nextBase,
    analysis: {
      ...project.analysis,
      status: 'accepted',
      activeCandidateId: candidate.id,
      candidates: project.analysis.candidates.map((item) => item.id === candidate.id
        ? { ...item, status: 'accepted', adoptedAt } : item.status === 'candidate' ? { ...item, status: 'stale' } : item),
      lastError: '',
    },
  });
}

export function rejectScriptMasterAnalysisCandidate(projectInput: ScriptMasterProject, candidateId: string): ScriptMasterProject {
  const project = sanitizeScriptMasterProject(projectInput);
  if (!project.analysis.candidates.some((candidate) => candidate.id === candidateId)) return project;
  return {
    ...project,
    analysis: {
      ...project.analysis,
      status: 'idle',
      activeCandidateId: null,
      candidates: project.analysis.candidates.map((candidate) => candidate.id === candidateId ? { ...candidate, status: 'rejected' } : candidate),
    },
    updatedAt: nowIso(),
  };
}

function issue(
  severity: ScriptMasterIssueSeverity,
  code: string,
  message: string,
  refs: Partial<Pick<ScriptMasterQualityIssue, 'shotId' | 'trackId' | 'assetId'>> = {},
  fixes: string[] = [],
): ScriptMasterQualityIssue {
  return {
    id: stableId('issue', `${severity}:${code}:${message}:${refs.shotId || ''}:${refs.assetId || ''}`),
    severity,
    code,
    message,
    shotId: refs.shotId || null,
    trackId: refs.trackId || null,
    assetId: refs.assetId || null,
    fixes,
  };
}

function scriptMasterBindingAllowsMedia(roleInput: string, mediaKind: ScriptMasterMediaKind): boolean {
  const role = roleInput.trim().toLocaleLowerCase();
  if (!role) return true;
  if (/^(?:voice-profile|dialogue-audio|music|ambience|sfx)$|声音|音色|对白音频|配乐|环境声|音效|audio|voice|sound/.test(role)) {
    return mediaKind === 'audio';
  }
  if (/^(?:video)$|参考视频|首帧视频|尾帧视频/.test(role)) return mediaKind === 'video';
  if (/^(?:image)$|人物|角色|造型|服装|场景|商品|产品|道具|参考图|character|look|scene|product|prop/.test(role)) {
    return mediaKind === 'image' || mediaKind === 'video';
  }
  return true;
}

export function validateScriptMasterProject(
  projectInput: ScriptMasterProject,
  targetInput: ScriptMasterTargetCapability = DEFAULT_SCRIPT_MASTER_TARGET,
): ScriptMasterQualityReport {
  const project = sanitizeScriptMasterProject(projectInput);
  const target = { ...DEFAULT_SCRIPT_MASTER_TARGET, ...targetInput };
  const issues: ScriptMasterQualityIssue[] = [];
  const sortedShots = [...project.shots].sort((left, right) => left.range.start.value - right.range.start.value);
  let expectedStart = 0;
  sortedShots.forEach((shot, shotIndex) => {
    const start = shot.range.start.value;
    const end = shot.range.end.value;
    if (end <= start) issues.push(issue('blocker', 'SHOT_INVALID_DURATION', `${shot.title} 的时长必须大于 0 帧`, { shotId: shot.id }, ['延长镜头', '删除该镜头']));
    if (start > expectedStart) issues.push(issue('blocker', 'PICTURE_GAP', `${formatScriptMasterTimecode(rationalTime(expectedStart, project.fps), project.fps)} 处存在画面空隙`, { shotId: shot.id, trackId: 'track-picture-main' }, ['吸附到上一镜结束', '显式加入黑场镜头']));
    if (start < expectedStart) issues.push(issue('blocker', 'PICTURE_OVERLAP', `${shot.title} 与上一镜发生非法画面重叠`, { shotId: shot.id, trackId: 'track-picture-main' }, ['移动镜头到剪辑点', '拆为显式转场']));
    expectedStart = Math.max(expectedStart, end);
    const duration = end - start;
    if (duration > target.maxDurationFrames) issues.push(issue('warning', 'TARGET_SEGMENTED', `${shot.title} 为 ${duration} 帧，将按目标单段 ${target.maxDurationFrames} 帧上限确定性拆为 ${Math.ceil(duration / target.maxDurationFrames)} 段`, { shotId: shot.id }, ['在动作点手动拆镜以优化节奏', '确认分段连续性 carry']));
    project.dialogueLines.filter((line) => line.shotId === shot.id).forEach((line) => {
      if (rangeDurationFrames(line.range, project.fps) > target.maxDurationFrames) {
        issues.push(issue('blocker', 'DIALOGUE_TARGET_DURATION_EXCEEDED', `${line.speakerName || '未定说话人'}的完整台词时长超过目标单段上限，不能从中间静默截断`, { shotId: shot.id }, ['缩短或重配台词音频', '在用户确认的停顿点拆分台词']));
      }
    });
    if (shotIndex > 0) {
      const previous = sortedShots[shotIndex - 1];
      const transitionFrames = finiteInteger(shot.transitionInFrames, 0, 0);
      const nonCut = !/^(?:硬切|cut|直切|无|none)$/i.test(shot.transitionIn.trim());
      if (nonCut && transitionFrames <= 0) issues.push(issue(project.strictMode ? 'blocker' : 'warning', 'TRANSITION_HANDLE_UNSPECIFIED', `${shot.title} 的“${shot.transitionIn}”未声明转场把手帧数`, { shotId: shot.id, trackId: 'track-transition-main' }, ['填写转场帧数', '改为硬切']));
      if (transitionFrames > 0) {
        const available = Math.min(rangeDurationFrames(previous.range, project.fps), rangeDurationFrames(shot.range, project.fps));
        if (transitionFrames * 2 > available) issues.push(issue('blocker', 'TRANSITION_HANDLE_INSUFFICIENT', `${shot.title} 的 ${transitionFrames} 帧转场超过相邻片段可用把手`, { shotId: shot.id, trackId: 'track-transition-main' }, ['缩短转场', '延长相邻镜头']));
      }
    }
    const refs = effectiveBindingsForNormalizedProject(project, shot);
    const counts = { image: 0, video: 0, audio: 0 };
    refs.forEach((binding) => {
      const asset = project.assets.find((item) => item.id === binding.assetId);
      if (!asset) {
        issues.push(issue('blocker', 'REFERENCE_ASSET_MISSING', `${binding.alias} 指向的素材不存在`, { shotId: shot.id, assetId: binding.assetId }, ['重新绑定素材', '移除失效引用']));
        return;
      }
      counts[asset.mediaKind] += 1;
      if (!scriptMasterBindingAllowsMedia(binding.role, asset.mediaKind)) {
        issues.push(issue('blocker', 'REFERENCE_MEDIA_TYPE_MISMATCH', `${binding.alias} 的媒体类型 ${asset.mediaKind} 与用途“${binding.role}”不匹配`, { shotId: shot.id, assetId: asset.id }, ['绑定正确类型素材', '修正引用用途但保留来源']));
      }
      if (binding.alias !== asset.alias || !aliasNumber(asset.alias, asset.mediaKind)) {
        issues.push(issue('blocker', 'REFERENCE_ALIAS_INVALID', `${binding.alias || '(空别名)'} 无法稳定解析到 ${asset.name}`, { shotId: shot.id, assetId: asset.id }, ['刷新引用绑定', '为素材重新分配未占用别名']));
      }
      if (binding.required && !asset.url) issues.push(issue('blocker', 'REFERENCE_MEDIA_UNRESOLVED', `${asset.alias} ${asset.name} 尚未绑定可读取媒体`, { shotId: shot.id, assetId: asset.id }, ['上传本地素材', '绑定上游或资源库素材']));
      if (binding.required && asset.url && asset.probeStatus !== 'ready') {
        issues.push(issue(project.strictMode ? 'blocker' : 'warning', asset.probeStatus === 'error' ? 'REFERENCE_MEDIA_PROBE_FAILED' : 'REFERENCE_MEDIA_UNPROBED',
          asset.probeStatus === 'error' ? `${asset.alias} 媒体探测失败：${asset.probeError || '未知错误'}` : `${asset.alias} 尚未完成真实媒体可读性探测`,
          { shotId: shot.id, assetId: asset.id }, ['重新探测媒体', '重新绑定可读素材']));
      }
      if (binding.assetRevision !== asset.revision || binding.contentHash !== asset.contentHash) issues.push(issue('blocker', 'REFERENCE_REVISION_STALE', `${asset.alias} 仍绑定旧 revision/hash`, { shotId: shot.id, assetId: asset.id }, ['确认并刷新到当前素材版本', '恢复被锁定的旧版本']));
      if (asset.kind === 'dialogue-audio' && asset.durationFrames != null) {
        const bindingDuration = rangeDurationFrames(timelineRangeForBinding(binding, project), project.fps);
        if (asset.durationFrames > bindingDuration) issues.push(issue('blocker', 'DIALOGUE_AUDIO_DURATION_EXCEEDS_RANGE', `${asset.alias} 实际音频 ${asset.durationFrames} 帧超过绑定范围 ${bindingDuration} 帧`, { shotId: shot.id, assetId: asset.id }, ['延长镜头或绑定范围', '修剪/重配台词音频']));
      }
    });
    if (counts.image > target.maxImageReferences) issues.push(issue('blocker', 'IMAGE_REFERENCE_LIMIT', `${shot.title} 使用 ${counts.image} 张参考图，超过目标上限 ${target.maxImageReferences}`, { shotId: shot.id }, ['缩小引用作用域', '拆分为多个合法片段']));
    if (counts.video > target.maxVideoReferences) issues.push(issue('blocker', 'VIDEO_REFERENCE_LIMIT', `${shot.title} 使用 ${counts.video} 个参考视频，超过目标上限 ${target.maxVideoReferences}`, { shotId: shot.id }, ['缩小引用作用域', '切换目标模型']));
    if (target.supportsNativeAudio && counts.audio > target.maxAudioReferences) issues.push(issue('blocker', 'AUDIO_REFERENCE_LIMIT', `${shot.title} 使用 ${counts.audio} 段音频，超过目标上限 ${target.maxAudioReferences}`, { shotId: shot.id }, ['将非原生音频移入 AudioPlan', '拆分片段或切换目标模型']));
    if (!target.supportsNativeAudio && counts.audio > 0) issues.push(issue('warning', 'AUDIO_PLAN_EXTERNALIZED', `${shot.title} 的 ${counts.audio} 段音频将进入独立 AudioPlan，不会伪装成视频模型参数`, { shotId: shot.id }, ['发送到音频/剪辑下游', '切换支持原生音频的目标模型']));
    const roughPromptCharacters = shot.title.length + shot.purpose.length + shot.visualDescription.length + shot.action.length
      + shot.mustInclude.join('').length + shot.mustAvoid.join('').length
      + project.dialogueLines.filter((line) => line.shotId === shot.id).reduce((sum, line) => sum + line.text.length + line.speakerName.length, 0)
      + refs.reduce((sum, binding) => sum + binding.alias.length + binding.role.length + 40, 0) + 300;
    if (roughPromptCharacters > target.maxPromptCharacters) issues.push(issue('blocker', 'PROMPT_CHARACTER_LIMIT', `${shot.title} 的预计提示词长度 ${roughPromptCharacters} 超过目标上限 ${target.maxPromptCharacters}`, { shotId: shot.id }, ['精简非必要描述但保留锁定事实', '在合法剪辑点拆镜']));
    const roleScopes = new Map<string, Set<ScriptMasterScope>>();
    refs.forEach((binding) => {
      const scopes = roleScopes.get(binding.role) || new Set<ScriptMasterScope>();
      scopes.add(binding.scope);
      roleScopes.set(binding.role, scopes);
    });
    roleScopes.forEach((scopes, role) => {
      if (scopes.size > 1) issues.push(issue('warning', 'REFERENCE_SCOPE_CONFLICT', `${shot.title} 的 ${role} 同时命中 ${[...scopes].join(' / ')} 作用域；已按锁定、本镜、自定义、本场、全片排序但未静默覆盖`, { shotId: shot.id }, ['在检查器确认全部引用', '缩小或解除冲突作用域']));
    });
  });
  project.dialogueLines.forEach((line) => {
    if (!line.speakerId || !project.entities.some((entity) => entity.id === line.speakerId && entity.kind === 'character')) {
      issues.push(issue('blocker', 'DIALOGUE_SPEAKER_UNRESOLVED', `台词“${line.text.slice(0, 28)}”的说话人未确定`, { shotId: line.shotId }, ['从候选人物中选择说话人', '新建人物并保留原文证据']));
    }
    const shot = project.shots.find((item) => item.id === line.shotId);
    if (shot && (line.range.start.value < shot.range.start.value || line.range.end.value > shot.range.end.value) && !line.allowAcrossShots) {
      issues.push(issue('blocker', 'DIALOGUE_OUTSIDE_SHOT', `${line.speakerName || '未定说话人'}的台词超出所属镜头`, { shotId: line.shotId }, ['延长镜头或拆镜', '重配/改词并由用户确认']));
    }
  });
  project.entities.forEach((entity) => {
    if ((entity.status === 'confirmed' || entity.status === 'locked') && entity.sourceSpanIds.length === 0) {
      issues.push(issue('blocker', 'CONFIRMED_FACT_WITHOUT_SOURCE', `${entity.name} 被标记为${entity.status === 'locked' ? '锁定' : '已确认'}，但没有来源范围`, {}, ['补充原文证据', '降级为待确认']));
    }
  });
  if (!project.sourceDocuments.length) issues.push(issue('warning', 'SOURCE_MISSING', '尚未导入剧本原文', {}, ['粘贴或上传 TXT / Markdown / Fountain']));
  if (!project.shots.length) issues.push(issue('warning', 'SHOT_LIST_EMPTY', '尚未得到可编译镜头', {}, ['执行仅导入确定性解析', '手动新增镜头']));
  if (project.domain === 'unconfirmed') issues.push(issue('warning', 'DOMAIN_UNCONFIRMED', '创作类型仍待确认；系统没有按故事片擅自补写', {}, ['选择叙事、电商、广告、MV、纪录或口播/教学']));
  const allSourceSpans = project.sourceDocuments.flatMap((document) => document.spans).filter((span) => span.text.trim());
  const knownSourceSpanIds = new Set(allSourceSpans.map((span) => span.id));
  const coveredSourceSpanIds = new Set([
    ...project.entities.flatMap((entity) => entity.sourceSpanIds),
    ...project.scenes.flatMap((scene) => scene.sourceSpanIds),
    ...project.shots.flatMap((shot) => shot.sourceSpanIds),
    ...project.dialogueLines.flatMap((line) => line.sourceSpanIds),
    ...project.audioEvents.flatMap((event) => event.sourceSpanIds),
  ].filter((spanId) => knownSourceSpanIds.has(spanId)));
  const sourceCoveragePercent = allSourceSpans.length ? Math.round(coveredSourceSpanIds.size / allSourceSpans.length * 100) : 0;
  if (project.strictMode && allSourceSpans.length > 0 && sourceCoveragePercent < 100) {
    issues.push(issue('blocker', 'STRICT_SOURCE_COVERAGE', `严格模式源文本覆盖率为 ${sourceCoveragePercent}%，必须达到 100%`, {}, ['定位未映射原文', '把未采用内容明确标为排除并保留证据']));
  }
  if (project.domain !== 'unconfirmed') {
    const pack = SCRIPT_MASTER_DOMAIN_PACKS[project.domain];
    const sourceText = project.sourceDocuments.map((document) => document.content).join('\n').toLocaleLowerCase();
    if (project.domain === 'ecommerce' && !/(商品|产品|卖点|product|sku|cta|购买|下单)/i.test(sourceText)) issues.push(issue('blocker', 'ECOMMERCE_PRODUCT_EVIDENCE', `${pack.label}缺少商品、卖点或 CTA 的原文证据`, {}, ['补充商品事实', '切换正确创作类型']));
    if (project.domain === 'advertising' && !/(品牌|logo|包装|brand|cta|行动|记忆点)/i.test(sourceText)) issues.push(issue('blocker', 'ADVERTISING_BRAND_CONSTRAINT', `${pack.label}缺少品牌约束或行动证据`, {}, ['补充品牌规范', '把未知项保留为待确认']));
    if (project.domain === 'music-video' && !project.audioEvents.some((event) => event.role === 'music') && !/(歌词|副歌|bpm|beat|music|bgm)/i.test(sourceText)) issues.push(issue('blocker', 'MV_MUSIC_EVIDENCE', `${pack.label}缺少音乐、歌词或拍点证据`, {}, ['导入歌词/音乐标记', '绑定音乐素材']));
    if (project.domain === 'documentary' && project.entities.some((entity) => entity.kind === 'fact' && entity.sourceSpanIds.length === 0)) issues.push(issue('blocker', 'DOCUMENTARY_FACT_SOURCE', `${pack.label}存在无来源事实`, {}, ['绑定事实来源', '保持为未确认而非事实']));
    if (project.domain === 'tutorial' && !/(步骤|第[一二三四五六七八九十\d]+步|step\s*\d+)/i.test(sourceText)) issues.push(issue('blocker', 'TUTORIAL_STEP_ORDER', `${pack.label}缺少可追踪步骤顺序`, {}, ['补充显式步骤', '切换正确创作类型']));
  }
  return {
    id: createId('quality-report'),
    projectId: project.projectId,
    projectRevision: project.revision,
    targetCapabilityId: target.id,
    createdAt: nowIso(),
    blockers: issues.filter((item) => item.severity === 'blocker').length,
    warnings: issues.filter((item) => item.severity === 'warning').length,
    sourceCoveragePercent,
    issues,
  };
}

function manifestForBindings(project: ScriptMasterProject, bindings: ScriptMasterBinding[]): ScriptMasterReferenceManifestItem[] {
  return bindings.flatMap((binding) => {
    const asset = project.assets.find((item) => item.id === binding.assetId);
    return asset ? [{
      alias: asset.alias,
      assetId: asset.id,
      assetRevision: asset.revision,
      contentHash: asset.contentHash,
      mediaKind: asset.mediaKind,
      role: binding.role,
      scope: binding.scope,
      url: asset.url,
    }] : [];
  });
}

function audioPlanForShot(project: ScriptMasterProject, shot: ScriptMasterShot, bindings: ScriptMasterBinding[]): ScriptMasterAudioPlanItem[] {
  const items: ScriptMasterAudioPlanItem[] = project.dialogueLines.filter((line) => line.shotId === shot.id).map((line) => ({
    id: line.id,
    shotId: shot.id,
    role: 'dialogue',
    range: cloneRange(line.range),
    text: line.text,
    speakerId: line.speakerId,
    assetId: null,
    alias: '',
  }));
  project.audioEvents.filter((event) => event.shotId === shot.id).forEach((event) => {
    const asset = event.assetId ? project.assets.find((candidate) => candidate.id === event.assetId) : null;
    items.push({
      id: event.id,
      shotId: shot.id,
      role: event.role,
      range: cloneRange(event.range),
      text: event.description,
      speakerId: null,
      assetId: asset?.id || null,
      alias: asset?.alias || '',
    });
  });
  bindings.forEach((binding) => {
    const asset = project.assets.find((candidate) => candidate.id === binding.assetId && candidate.mediaKind === 'audio');
    if (!asset || items.some((item) => item.assetId === asset.id)) return;
    items.push({
      id: binding.id,
      shotId: shot.id,
      role: binding.role,
      range: timelineRangeForBinding(binding, project),
      text: asset.name,
      speakerId: null,
      assetId: asset.id,
      alias: asset.alias,
    });
  });
  return items;
}

function promptForShot(
  project: ScriptMasterProject,
  shot: ScriptMasterShot,
  references: ScriptMasterReferenceManifestItem[],
  audioPlan: ScriptMasterAudioPlanItem[],
  includeNativeAudio: boolean,
  segmentRange: RationalTimeRange = shot.range,
  segmentIndex = 0,
  segmentCount = 1,
): { prompt: string; reverseMap: ScriptMasterPromptPack['reverseMap'] } {
  const dialogue = project.dialogueLines.filter((line) => line.shotId === shot.id
    && line.range.end.value > segmentRange.start.value && line.range.start.value < segmentRange.end.value);
  const referenceText = references.map((item) => `${item.alias} = ${item.role}（${item.scope}，revision:r${item.assetRevision}）`).join('\n');
  const dialogueText = dialogue.map((line) => `${line.speakerName || '说话人未定'}：“${line.text}”`).join('\n');
  const soundText = includeNativeAudio
    ? audioPlan.filter((item) => item.role !== 'dialogue').map((item) => `${item.alias ? `${item.alias} ` : ''}${item.role}：${item.text}`).join('\n')
    : '';
  const start = formatScriptMasterTimecode(segmentRange.start, project.fps);
  const end = formatScriptMasterTimecode(segmentRange.end, project.fps);
  const duration = (rangeDurationFrames(segmentRange, project.fps) / project.fps).toFixed(3);
  const visibleReferences = references.map((reference) => reference.alias).join(' ');
  const sections = [
    `[PROJECT]\n片名：${project.title}；类型：${project.domain}；画幅：${project.aspectRatio}；帧率：${project.fps}fps`,
    referenceText ? `[REFERENCES]\n${referenceText}` : '',
    `[SHOT ${String(project.shots.findIndex((item) => item.id === shot.id) + 1).padStart(2, '0')}${segmentCount > 1 ? `.${segmentIndex + 1}/${segmentCount}` : ''} | ${start}-${end} | ${duration}s]\n镜头：${shot.title}`,
    shot.purpose ? `目的：${shot.purpose}` : '',
    `画面：${shot.visualDescription || '待补可见画面'}${visibleReferences ? `；保持 ${visibleReferences} 的已确认身份与素材版本。` : ''}`,
    shot.action ? `动作：${shot.action}` : '',
    `摄影：${shot.shotSize}，${shot.camera}`,
    `转场：${shot.transitionIn}；向下一镜 ${shot.transitionOut}`,
    dialogueText ? `台词：\n${dialogueText}` : '',
    soundText ? `声音：\n${soundText}` : '',
    shot.mustInclude.length ? `必须：${shot.mustInclude.join('；')}` : '',
    shot.mustAvoid.length ? `禁止：${shot.mustAvoid.join('；')}` : '',
  ].filter(Boolean);
  return {
    prompt: sections.join('\n\n'),
    reverseMap: [
      { promptSection: '画面', field: 'shots.visualDescription', sourceSpanIds: shot.sourceSpanIds },
      { promptSection: '动作', field: 'shots.action', sourceSpanIds: shot.sourceSpanIds },
      { promptSection: '台词', field: 'dialogueLines', sourceSpanIds: dialogue.flatMap((line) => line.sourceSpanIds) },
      { promptSection: '引用', field: 'bindings', sourceSpanIds: [] },
    ],
  };
}

function scriptMasterSegmentRanges(
  project: ScriptMasterProject,
  shot: ScriptMasterShot,
  maxFrames: number,
): RationalTimeRange[] {
  const ranges: RationalTimeRange[] = [];
  const protectedDialogue = project.dialogueLines.filter((line) => line.shotId === shot.id && !line.allowAcrossShots);
  let cursor = shot.range.start.value;
  while (cursor < shot.range.end.value) {
    const limit = Math.min(shot.range.end.value, cursor + maxFrames);
    if (limit >= shot.range.end.value) {
      ranges.push(rationalRange(cursor, shot.range.end.value, project.fps));
      break;
    }
    const isSafeCut = (frame: number) => !protectedDialogue.some((line) => line.range.start.value < frame && line.range.end.value > frame);
    let cut = limit;
    if (!isSafeCut(cut)) {
      const candidates = protectedDialogue
        .flatMap((line) => [line.range.start.value, line.range.end.value])
        .filter((frame) => frame > cursor && frame <= limit && isSafeCut(frame))
        .sort((left, right) => right - left);
      cut = candidates[0] || limit;
    }
    if (cut <= cursor) cut = limit;
    ranges.push(rationalRange(cursor, cut, project.fps));
    cursor = cut;
  }
  return ranges;
}

export function compileScriptMasterProject(
  projectInput: ScriptMasterProject,
  targetInput: ScriptMasterTargetCapability = DEFAULT_SCRIPT_MASTER_TARGET,
  shotIds?: string[],
): ScriptMasterCompilation {
  const project = sanitizeScriptMasterProject(projectInput);
  const target = { ...DEFAULT_SCRIPT_MASTER_TARGET, ...targetInput };
  const selected = shotIds?.length ? project.shots.filter((shot) => shotIds.includes(shot.id)) : project.shots;
  const promptPacks: ScriptMasterPromptPack[] = [];
  const referenceManifest: ScriptMasterReferenceManifestItem[] = [];
  const audioPlan: ScriptMasterAudioPlanItem[] = [];
  selected.forEach((shot) => {
    const bindings = effectiveBindingsForNormalizedProject(project, shot);
    const allReferences = manifestForBindings(project, bindings);
    const references = target.supportsNativeAudio ? allReferences : allReferences.filter((item) => item.mediaKind !== 'audio');
    const shotAudioPlan = audioPlanForShot(project, shot, bindings);
    const maxFrames = Math.max(1, finiteInteger(target.maxDurationFrames, rangeDurationFrames(shot.range, project.fps), 1));
    const ranges = scriptMasterSegmentRanges(project, shot, maxFrames);
    const segmentCount = ranges.length;
    const segmentIds = ranges.map((range, index) => stableId('prompt-segment', `${project.projectId}:${project.revision}:${shot.id}:${target.id}:${index}:${range.start.value}:${range.end.value}`));
    ranges.forEach((range, segmentIndex) => {
      const segmentAudioPlan = shotAudioPlan.flatMap((item) => {
        const start = Math.max(range.start.value, item.range.start.value);
        const end = Math.min(range.end.value, item.range.end.value);
        return end > start ? [{
          ...item,
          id: segmentCount > 1 ? stableId('audio-plan-item', `${item.id}:${segmentIds[segmentIndex]}`) : item.id,
          range: rationalRange(start, end, project.fps),
        }] : [];
      });
      const compiled = promptForShot(project, shot, references, segmentAudioPlan, target.supportsNativeAudio, range, segmentIndex, segmentCount);
      const deterministicHash = stableHash(JSON.stringify({
        projectId: project.projectId,
        projectRevision: project.revision,
        shotId: shot.id,
        targetCapabilityId: target.id,
        segmentIndex,
        range,
        prompt: compiled.prompt,
        references: references.map((item) => [item.alias, item.assetId, item.assetRevision, item.contentHash]),
        audioPlan: segmentAudioPlan,
      }));
      promptPacks.push({
        id: stableId('prompt-pack', `${project.projectId}:${project.revision}:${shot.id}:${target.id}:${segmentIndex}`),
        projectId: project.projectId,
        shotId: shot.id,
        targetCapabilityId: target.id,
        prompt: compiled.prompt,
        referenceAliases: references.map((item) => item.alias),
        references,
        audioPlan: segmentAudioPlan,
        sourceSpanIds: shot.sourceSpanIds,
        reverseMap: compiled.reverseMap,
        compiledAt: nowIso(),
        projectRevision: project.revision,
        segmentId: segmentIds[segmentIndex],
        segmentIndex,
        segmentCount,
        range,
        continuity: {
          previousSegmentId: segmentIds[segmentIndex - 1] || null,
          nextSegmentId: segmentIds[segmentIndex + 1] || null,
          carry: [...shot.characterIds, ...references.map((item) => item.alias), ...shot.mustInclude],
        },
        deterministicHash,
      });
      audioPlan.push(...segmentAudioPlan);
    });
    references.forEach((reference) => {
      if (!referenceManifest.some((item) => item.alias === reference.alias && item.assetId === reference.assetId)) referenceManifest.push(reference);
    });
  });
  const qualityReport = validateScriptMasterProject(project, target);
  const deterministicHash = stableHash(JSON.stringify({
    projectId: project.projectId,
    projectRevision: project.revision,
    target: target.id,
    promptPacks: promptPacks.map((pack) => pack.deterministicHash),
    referenceManifest: referenceManifest.map((item) => [item.alias, item.assetId, item.assetRevision, item.contentHash]),
    audioPlan,
    edl: selected.map((shot) => [shot.id, shot.range.start.value, shot.range.end.value]),
  }));
  return {
    promptPacks,
    humanPrompt: promptPacks.map((pack) => pack.prompt).join('\n\n---\n\n'),
    referenceManifest,
    audioPlan,
    edl: selected.map((shot) => ({
      shotId: shot.id,
      sceneId: shot.sceneId,
      title: shot.title,
      startFrame: shot.range.start.value,
      endFrame: shot.range.end.value,
      sourceSpanIds: shot.sourceSpanIds,
    })),
    qualityReport,
    deterministicHash,
  };
}

export function applyScriptMasterCompilation(
  projectInput: ScriptMasterProject,
  compilation: ScriptMasterCompilation,
): ScriptMasterProject {
  const project = sanitizeScriptMasterProject(projectInput);
  return {
    ...project,
    promptPacks: compilation.promptPacks,
    qualityReports: [...project.qualityReports, compilation.qualityReport].slice(-50),
    updatedAt: nowIso(),
  };
}

export function scriptMasterProjectSummary(projectInput: ScriptMasterProject): {
  durationFrames: number;
  durationSeconds: number;
  scenes: number;
  shots: number;
  characters: number;
  images: number;
  videos: number;
  audios: number;
  blockers: number;
  warnings: number;
} {
  const project = sanitizeScriptMasterProject(projectInput);
  const report = validateScriptMasterProject(project, project.compileTargets[0] || DEFAULT_SCRIPT_MASTER_TARGET);
  return {
    durationFrames: project.targetDurationFrames,
    durationSeconds: project.targetDurationFrames / project.fps,
    scenes: project.scenes.length,
    shots: project.shots.length,
    characters: project.entities.filter((entity) => entity.kind === 'character').length,
    images: project.assets.filter((asset) => asset.mediaKind === 'image').length,
    videos: project.assets.filter((asset) => asset.mediaKind === 'video').length,
    audios: project.assets.filter((asset) => asset.mediaKind === 'audio').length,
    blockers: report.blockers,
    warnings: report.warnings,
  };
}

export function scriptMasterToDirectorShots(projectInput: ScriptMasterProject): Array<{
  id: string;
  title: string;
  durationSec: number;
  prompt: string;
  negativePrompt: string;
  frameMode: 'auto';
  localRefImages: string[];
  localRefVideos: string[];
  localRefAudios: string[];
  localRefOrder: Array<{ kind: ScriptMasterMediaKind; url: string }>;
  scriptMasterLineage: { projectId: string; sceneId: string; shotId: string; segmentId: string; segmentIndex: number; segmentCount: number; revision: number; sourceSpanIds: string[] };
}> {
  const project = sanitizeScriptMasterProject(projectInput);
  const compilation = compileScriptMasterProject(project);
  return compilation.promptPacks.flatMap((pack) => {
    const shot = project.shots.find((item) => item.id === pack.shotId);
    if (!shot) return [];
    const refs = pack.references || [];
    return {
      id: pack.segmentCount > 1 ? `${shot.id}-segment-${pack.segmentIndex + 1}` : shot.id,
      title: pack.segmentCount > 1 ? `${shot.title} · ${pack.segmentIndex + 1}/${pack.segmentCount}` : shot.title,
      durationSec: rangeDurationFrames(pack.range, project.fps) / project.fps,
      prompt: pack.prompt || '',
      negativePrompt: shot.mustAvoid.join('，'),
      frameMode: 'auto' as const,
      localRefImages: refs.filter((item) => item.mediaKind === 'image').map((item) => item.url).filter(Boolean),
      localRefVideos: refs.filter((item) => item.mediaKind === 'video').map((item) => item.url).filter(Boolean),
      localRefAudios: refs.filter((item) => item.mediaKind === 'audio').map((item) => item.url).filter(Boolean),
      localRefOrder: refs.filter((item) => item.url).map((item) => ({ kind: item.mediaKind, url: item.url })),
      scriptMasterLineage: {
        projectId: project.projectId,
        sceneId: shot.sceneId,
        shotId: shot.id,
        segmentId: pack.segmentId,
        segmentIndex: pack.segmentIndex,
        segmentCount: pack.segmentCount,
        revision: project.revision,
        sourceSpanIds: shot.sourceSpanIds,
      },
    };
  });
}

function sourceSpanForStory(project: ScriptMasterProject, sourceSpanIds: string[]) {
  const spans = project.sourceDocuments.flatMap((document) => document.spans).filter((span) => sourceSpanIds.includes(span.id));
  return {
    start: spans.length ? Math.min(...spans.map((span) => span.startChar)) : 0,
    end: spans.length ? Math.max(...spans.map((span) => span.endChar)) : 0,
    text: spans.map((span) => span.text).join('\n'),
  };
}

function storyProjectFromScriptMaster(project: ScriptMasterProject) {
  const script = project.sourceDocuments.map((document) => document.content).join('\n\n');
  const base = createEmptyStoryProject({ storyId: `story-${project.projectId}`, title: project.title, script });
  base.settings = {
    ...base.settings,
    aspectRatio: project.aspectRatio,
    targetDurationSec: Math.max(4, Math.round(project.targetDurationFrames / project.fps)),
    llmProviderSource: (project.providerSelections.llm.provider || 'zhenzhen') as any,
    llmProviderId: project.providerSelections.llm.provider === 'zhenzhen' ? '' : project.providerSelections.llm.provider,
    llmProviderModel: project.providerSelections.llm.model,
    videoProviderSource: (project.providerSelections.video.provider || 'zhenzhen') as any,
    videoProviderId: project.providerSelections.video.provider === 'zhenzhen' ? '' : project.providerSelections.video.provider,
    videoProviderModel: project.providerSelections.video.model,
  };
  const analysis = {
    schema: STORY_ANALYSIS_SCHEMA,
    title: project.title,
    styleBible: project.globalConstraints.join('；'),
    scenes: project.scenes.map((scene) => ({
      id: scene.id,
      title: scene.title,
      description: sourceSpanForStory(project, scene.sourceSpanIds).text,
      sourceSpan: sourceSpanForStory(project, scene.sourceSpanIds),
    })),
    shots: project.shots.map((shot) => ({
      id: shot.id,
      sceneId: shot.sceneId,
      title: shot.title,
      sourceSpan: sourceSpanForStory(project, shot.sourceSpanIds),
      durationSec: rangeDurationFrames(shot.range, project.fps) / project.fps,
      visualDescription: shot.visualDescription,
      action: shot.action,
      dialogue: project.dialogueLines.filter((line) => line.shotId === shot.id).map((line) => `${line.speakerName}：${line.text}`).join('\n'),
      voiceover: project.audioEvents.filter((event) => event.shotId === shot.id && event.role === 'voiceover').map((event) => event.description).join('\n'),
      sfx: project.audioEvents.filter((event) => event.shotId === shot.id && event.role === 'sfx').map((event) => event.description).join('\n'),
      camera: `${shot.shotSize}，${shot.camera}`,
      lighting: '',
      mustInclude: shot.mustInclude,
      mustNotInclude: shot.mustAvoid,
      entityRefs: shot.characterIds,
      assetIds: effectiveBindingsForNormalizedProject(project, shot).map((binding) => binding.assetId),
      finalPrompt: project.promptPacks.find((pack) => pack.shotId === shot.id)?.prompt || '',
      negativePrompt: shot.mustAvoid.join('，'),
      status: 'pending',
      videoUrl: '', taskId: '', taskProvider: '', taskModel: '', error: '',
      lockedFields: shot.locked ? ['*'] : [],
      revision: shot.revision,
    })),
    assets: project.assets.map((asset) => ({
      id: asset.id,
      kind: asset.mediaKind === 'audio' ? 'audio' : project.bindings.some((binding) => binding.assetId === asset.id && /character|人物|角色/i.test(binding.role)) ? 'character' : 'scene',
      name: asset.name,
      description: `${asset.alias} · ${asset.kind}`,
      prompt: '', negativePrompt: '',
      requiredByShotIds: project.shots.filter((shot) => effectiveBindingsForNormalizedProject(project, shot).some((binding) => binding.assetId === asset.id)).map((shot) => shot.id),
      source: asset.url ? 'existing' : 'missing',
      status: asset.url ? 'succeeded' : 'idle',
      url: asset.url,
      taskId: '', taskProvider: '', taskModel: '', taskEndpoint: '', taskClipIds: [], error: '',
      locked: asset.locked,
      revision: asset.revision,
      generatedAt: '',
    })),
  };
  return applyStoryAnalysis(base, analysis as any, 'local-fallback');
}

function videoEditPayloadFromScriptMaster(project: ScriptMasterProject, compilation: ScriptMasterCompilation) {
  const videoAssets = project.assets.filter((asset) => asset.mediaKind === 'video');
  const clips: VideoEditClip[] = videoAssets.map((asset) => ({
    id: stableId('video-edit-clip', `${project.projectId}:${asset.id}:${asset.revision}`),
    assetId: asset.id,
    sourceNodeId: '',
    sourceLabel: `${asset.alias} ${asset.name}`,
    name: asset.name,
    url: asset.url,
    mime: asset.mime,
    duration: asset.durationFrames == null ? undefined : asset.durationFrames / project.fps,
    width: asset.width || undefined,
    height: asset.height || undefined,
    hasAudio: asset.hasAudio == null ? undefined : asset.hasAudio,
    trimStart: 0,
    trimEnd: asset.durationFrames == null ? undefined : asset.durationFrames / project.fps,
    status: asset.probeStatus === 'error' ? 'error' : asset.url ? asset.probeStatus === 'ready' ? 'ready' : 'probing' : 'missing',
    error: asset.probeError,
  }));
  return {
    ...SCRIPT_MASTER_VIDEO_EDIT_DEFAULT_DATA,
    clips,
    settings: {
      ...SCRIPT_MASTER_VIDEO_EDIT_DEFAULT_DATA.settings,
      aspect: (['16:9', '9:16', '1:1', '3:4', '4:3', '21:9', '2:1'].includes(project.aspectRatio) ? project.aspectRatio : 'first') as any,
      targetDuration: project.targetDurationFrames / project.fps,
    },
    job: { ...SCRIPT_MASTER_VIDEO_EDIT_DEFAULT_DATA.job },
    scriptMasterEdl: compilation.edl,
    scriptMasterAudioPlan: compilation.audioPlan,
  };
}

export function buildScriptMasterDownstreamPayloads(
  projectInput: ScriptMasterProject,
  target: ScriptMasterDownstreamTarget,
): ScriptMasterDownstreamNodePayload[] {
  const project = sanitizeScriptMasterProject(projectInput);
  const compilation = compileScriptMasterProject(project, project.compileTargets[0] || DEFAULT_SCRIPT_MASTER_TARGET);
  if (compilation.qualityReport.blockers > 0) throw new Error(`仍有 ${compilation.qualityReport.blockers} 个硬阻断，不能发送下游`);
  const baseBinding = {
    schema: 't8-script-master-production-binding-v1',
    projectId: project.projectId,
    projectRevision: project.revision,
    compilationHash: compilation.deterministicHash,
  };
  let descriptors: Array<{ nodeId: string; label: string; data: Record<string, unknown> }> = [];
  if (target === 'story') {
    descriptors = [{
      nodeId: stableId('story-node', project.projectId),
      label: `${project.title} · Story`,
      data: { storyProject: storyProjectFromScriptMaster(project), storyRunMode: 'all', status: 'ready', scriptMasterBinding: baseBinding },
    }];
  } else if (target === 'director-storyboard') {
    descriptors = [{
      nodeId: stableId('director-node', project.projectId),
      label: `${project.title} · 导演分镜`,
      data: {
        shots: scriptMasterToDirectorShots(project),
        ratio: project.aspectRatio,
        generateAudio: project.compileTargets[0]?.supportsNativeAudio !== false,
        shotResults: {}, videoUrls: [], status: 'idle',
        scriptMasterBinding: baseBinding,
      },
    }];
  } else if (target === 'seedance') {
    descriptors = compilation.promptPacks.map((pack) => ({
      nodeId: stableId('seedance-node', `${project.projectId}:${pack.segmentId}`),
      label: `${project.title} · ${pack.segmentIndex + 1}/${pack.segmentCount}`,
      data: {
        prompt: pack.prompt,
        imageUrls: pack.references.filter((item) => item.mediaKind === 'image').map((item) => item.url).filter(Boolean),
        videoUrls: pack.references.filter((item) => item.mediaKind === 'video').map((item) => item.url).filter(Boolean),
        audioUrls: pack.references.filter((item) => item.mediaKind === 'audio').map((item) => item.url).filter(Boolean),
        duration: rangeDurationFrames(pack.range, project.fps) / project.fps,
        ratio: project.aspectRatio,
        generateAudio: project.compileTargets[0]?.supportsNativeAudio !== false,
        status: 'idle',
        scriptMasterBinding: { ...baseBinding, shotId: pack.shotId, segmentId: pack.segmentId, promptPackId: pack.id },
      },
    }));
  } else if (target === 'audio') {
    descriptors = [{
      nodeId: stableId('audio-node', project.projectId),
      label: `${project.title} · AudioPlan`,
      data: {
        audioProviderMode: compilation.audioPlan.some((item) => item.role === 'music') ? 'suno' : 'seed-audio',
        prompt: compilation.audioPlan.map((item) => `${formatScriptMasterTimecode(item.range.start, project.fps)} ${item.role}：${item.text}`).join('\n'),
        scriptMasterAudioPlan: compilation.audioPlan,
        status: 'idle',
        scriptMasterBinding: baseBinding,
      },
    }];
  } else {
    descriptors = [{
      nodeId: stableId('video-edit-node', project.projectId),
      label: `${project.title} · VideoEdit`,
      data: { ...videoEditPayloadFromScriptMaster(project, compilation), scriptMasterBinding: baseBinding },
    }];
  }
  return descriptors.map((descriptor) => {
    const payloadDigest = stableHash(JSON.stringify(descriptor.data));
    const link = project.downstreamLinks.find((item) => item.target === target && item.nodeId === descriptor.nodeId);
    return {
      target,
      nodeType: target,
      nodeId: link?.nodeId || descriptor.nodeId,
      label: descriptor.label,
      data: descriptor.data,
      payloadDigest,
      mode: link?.status === 'applied' ? 'update' : 'create',
    };
  });
}

export function recordScriptMasterDownstreamApply(
  projectInput: ScriptMasterProject,
  payloads: ScriptMasterDownstreamNodePayload[],
  patchId: string,
  canvasRevision: number,
): ScriptMasterProject {
  const project = sanitizeScriptMasterProject(projectInput);
  const updatedAt = nowIso();
  const keyed = new Map(project.downstreamLinks.map((link) => [`${link.target}:${link.nodeId}`, link]));
  payloads.forEach((payload) => keyed.set(`${payload.target}:${payload.nodeId}`, {
    id: stableId('downstream-link', `${project.projectId}:${payload.target}:${payload.nodeId}`),
    target: payload.target,
    nodeId: payload.nodeId,
    projectRevision: project.revision,
    payloadDigest: payload.payloadDigest,
    patchId: cleanString(patchId, 160),
    canvasRevision: finiteInteger(canvasRevision, 0, 0),
    runId: keyed.get(`${payload.target}:${payload.nodeId}`)?.runId || '',
    status: 'applied',
    updatedAt,
  }));
  return { ...project, downstreamLinks: [...keyed.values()].slice(-100), updatedAt };
}

export function applyScriptMasterWriteback(projectInput: ScriptMasterProject, input: ScriptMasterWritebackInput): ScriptMasterProject {
  let project = sanitizeScriptMasterProject(projectInput);
  if (!input || input.schema !== 't8-script-master-writeback-v1' || input.projectId !== project.projectId) throw new Error('下游回写不属于当前剧本大师项目');
  const link = project.downstreamLinks.find((item) => item.target === input.target && item.nodeId === input.nodeId && item.status === 'applied');
  if (!link || input.projectRevision !== link.projectRevision || input.projectRevision !== project.revision) throw new Error('下游回写 revision 已过期，不能按数组位置覆盖');
  const knownShotIds = new Set(project.shots.map((shot) => shot.id));
  input.shots.forEach((result, index) => {
    if (!knownShotIds.has(result.shotId)) throw new Error(`下游回写包含未知 shotId：${result.shotId}`);
    if (result.videoUrl) project = addScriptMasterAsset(project, {
      id: stableId('asset-writeback-video', `${input.nodeId}:${input.runId}:${result.shotId}:${result.segmentId || index}`),
      kind: 'video',
      name: `${project.shots.find((shot) => shot.id === result.shotId)?.title || '镜头'} 回写视频`,
      url: result.videoUrl,
      source: 'generated',
      sourceKey: `writeback:${input.nodeId}:${input.runId}:${result.shotId}:${result.segmentId || index}:video`,
      scope: 'shot', shotIds: [result.shotId], role: 'generated-shot', required: false,
      probeStatus: 'unprobed',
    });
    if (result.audioUrl) project = addScriptMasterAsset(project, {
      id: stableId('asset-writeback-audio', `${input.nodeId}:${input.runId}:${result.shotId}:${result.segmentId || index}`),
      kind: 'dialogue-audio',
      name: `${project.shots.find((shot) => shot.id === result.shotId)?.title || '镜头'} 回写音频`,
      url: result.audioUrl,
      source: 'generated',
      sourceKey: `writeback:${input.nodeId}:${input.runId}:${result.shotId}:${result.segmentId || index}:audio`,
      scope: 'shot', shotIds: [result.shotId], role: 'generated-audio', required: false,
      probeStatus: 'unprobed',
    });
    project.lineage.push({
      id: stableId('lineage-writeback', `${input.nodeId}:${input.runId}:${result.shotId}:${result.segmentId || index}`),
      kind: 'downstream-writeback',
      sourceId: `${input.nodeId}:${input.runId}`,
      targetId: result.shotId,
      revision: project.revision,
    });
  });
  return {
    ...project,
    downstreamLinks: project.downstreamLinks.map((item) => item.id === link.id ? {
      ...item,
      projectRevision: project.revision,
      runId: cleanString(input.runId, 160),
      status: 'applied',
      updatedAt: nowIso(),
    } : item),
  };
}

export function scriptMasterExportBundle(projectInput: ScriptMasterProject): {
  schema: 't8-script-master-export-v1';
  project: ScriptMasterProject;
  compilation: ScriptMasterCompilation;
  directorShots: ReturnType<typeof scriptMasterToDirectorShots>;
} {
  const project = sanitizeScriptMasterProject(projectInput);
  return {
    schema: 't8-script-master-export-v1',
    project,
    compilation: compileScriptMasterProject(project),
    directorShots: scriptMasterToDirectorShots(project),
  };
}
