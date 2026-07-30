import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Handle, Position, useReactFlow, type NodeProps } from '@xyflow/react';
import { AlertCircle, Loader2, Video as VideoIcon, Sparkles, Square, X } from 'lucide-react';
import {
  VIDEO_MODELS,
  inferVideoBuiltinSource,
  isZhenzhenApimartVideoModel,
  videoModelOptionsForSource,
  videoModelsForSource,
  type VideoBuiltinSource,
  ZHENZHEN_VIDEO_G_OMNI_FLASH_MODEL,
  ZHENZHEN_VIDEO_GK_V15_MODEL,
  ZHENZHEN_VIDEO_V31_FAST_MODEL,
  ZHENZHEN_VIDEO_V31_LITE_MODEL,
  ZHENZHEN_VIDEO_V31_QUALITY_MODEL,
  GROK_VIDEO_1_5_NEW_SIZES,
  grokVideo15NewSizeFromRatio,
  isFalVideoModel,
  isGrokVideo15NewModel,
  VIDEO_FAL_REGISTRY,
  VEO_FAL_RATIOS,
  VEO_FAL_DURATIONS,
  VEO_FAL_RESOLUTIONS,
  GROK_FAL_RATIOS,
  GROK_FAL_RESOLUTIONS,
  GROK_FAL_MODES,
  SORA2_FAL_MODES,
  SORA2_FAL_RATIOS,
  SORA2_FAL_DURATIONS,
  SORA2_FAL_RESOLUTIONS,
} from '../../providers/models';
import {
  generateExternalVideo,
  submitHappyHorse,
  queryHappyHorse,
  submitHailuo,
  queryHailuo,
  submitKling,
  queryKling,
  submitUpscaler,
  queryUpscaler,
  submitVidu,
  queryVidu,
  submitWan,
  queryWan,
  submitSeedance,
  querySeedance,
  submitVideo,
  queryVideo,
  submitVideoFal,
  queryVideoFal,
  type VideoSubmitRequest,
  type VideoFalSubmitRequest,
  type Hailuo23Model,
  type KlingModel,
  type UpscalerResolution,
  type ViduQ3Model,
} from '../../services/generation';
import { useUpdateNodeData } from './useUpdateNodeData';
import { useHasAutoOutput } from './useHasAutoOutput';
import { useRunTrigger } from '../../hooks/useRunTrigger';
import { requestCanvasNodeRun } from '../../utils/canvasRunRequest';
import type { RunNodeLifecycleReporter } from '../../types/project';
import { logBus } from '../../stores/logs';
import { useThemeStore } from '../../stores/theme';
import { useUpstreamMaterials, type Material } from './useUpstreamMaterials';
import { useOrderedMaterials } from './useOrderedMaterials';
import MaterialPreviewSection from './MaterialPreviewSection';
import ReuseResultToggle from './ReuseResultToggle';
import MentionPromptInput from './MentionPromptInput';
import LoopingVideo from '../LoopingVideo';
import SmartImage from '../SmartImage';
import { resolveMediaMentions, type MediaMention } from './mediaMentions';
import { useDragMaterialStore, type MaterialPayload } from '../../stores/dragMaterial';
import { useMaterialDropTarget } from '../../hooks/useMaterialDropTarget';
import { taskCompletionSound } from '../../stores/taskCompletionSound';
import { useApiKeysStore } from '../../stores/apiKeys';
import { normalizeProviderErrorMessage } from '../../utils/providerErrorMessage.ts';
import { hasReusableGenerationResult, shouldReuseGenerationResult } from '../../utils/reuseGenerationResult';
import {
  advancedProviderModelOptions,
  advancedProvidersForNode,
  resolveAdvancedProviderSelection,
} from '../../utils/advancedProviders';
import {
  countExcludedMaterials,
  excludeMaterialId,
  filterExcludedMaterials,
  normalizeExcludedMaterialIds,
} from '../../utils/materialExclusion';
import { LocalNodeAddonSlot } from 'virtual:t8-local-extensions';
import JimengCliHelpButton from './JimengCliHelpButton';

/**
 * VideoNode - 异步视频生成(完全对齐 gpt-image-2-web)
 * 支持:
 *   - Veo      (kind=veo)       — 默认 veo-omni-10s / 旧 Veo 3.1 子模型 / images(≤3)
 *   - Grok Video(kind=grok)     — Zhenzhen Grok 1.5 New / Grok Video 1.5 FAL / 旧版 FAL / grok-video-3 / images
 *   - Sora2    (kind=sora)      — Zhenzhen API + FAL 双渠道 / Base64 参考图(≤1)
 *   - HappyHorse(kind=happyhorse)— api.seedance.nz 文生/图生/参考图生视频(≤9 图)
 *   - Hailuo   (kind=hailuo)    — api.seedance.nz Hailuo 2.3 文生/图生/Fast 图生视频(1 张首帧)
 *   - Vidu     (kind=vidu)      — api.seedance.nz Vidu Q3 文生/图生/首尾帧/参考/短剧成片(≤14 图)
 *   - Kling    (kind=kling)     — api.seedance.nz Kling 文生/图生/首尾帧/参考/视频编辑
 *   - Wan      (kind=wan)       — api.seedance.nz Wan 2.7 Spicy 图生视频(1 张首帧)
 *   - Seedance  (kind=seedance) — 零破坏兼容旧 veo 字段
 * 流程: submit → poll(5s 间隔) → 转存 → 展示
 */
const VIDEO_POLL_TIMEOUT_SECONDS = 3600;
const VIDEO_POLL_INTERVAL_MS = 5000;
const VIDEO_MAX_POLL = Math.ceil((VIDEO_POLL_TIMEOUT_SECONDS * 1000) / VIDEO_POLL_INTERVAL_MS);
const VIDEO_FAL_POLL_INTERVAL_MS = 6000;
const VIDEO_FAL_MAX_POLL = Math.ceil((VIDEO_POLL_TIMEOUT_SECONDS * 1000) / VIDEO_FAL_POLL_INTERVAL_MS);
const JIMENG_SEEDANCE_LIMITS = { images: 9, multiframeImages: 20, videos: 3, audios: 3 };
type JimengSeedanceMode = 'omni' | 'first' | 'firstlast' | 'multiframe';
const JIMENG_SEEDANCE_MODE_OPTIONS: Array<{ value: JimengSeedanceMode; label: string }> = [
  { value: 'omni', label: '全能参考' },
  { value: 'first', label: '首帧图生视频' },
  { value: 'firstlast', label: '首尾帧生视频' },
  { value: 'multiframe', label: '智能多帧' },
];

const splitGrokFalRefUrls = (raw: string): string[] =>
  String(raw || '')
    .split(/[\n,，]+/)
    .map((s) => s.trim())
    .filter(Boolean);

const normalizeJimengSeedanceMode = (value: unknown): JimengSeedanceMode => {
  const text = String(value || '').trim().toLowerCase();
  if (text === 'first') return 'first';
  if (text === 'firstlast' || text === 'first_last' || text === 'frames2video') return 'firstlast';
  if (text === 'multiframe' || text === 'smart' || text === 'smart-multiframe') return 'multiframe';
  return 'omni';
};

const VideoNode = ({ id, data, selected }: NodeProps) => {
  const update = useUpdateNodeData(id);
  const hasAutoOutput = useHasAutoOutput(id);
  const { getEdges, getNodes } = useReactFlow();
  const [error, setError] = useState<string | null>(null);
  const pollTimer = useRef<number | null>(null);
  const pollRejectRef = useRef<((reason?: any) => void) | null>(null);
  const generationRunRef = useRef(0);
  const src = `video:${id.slice(0, 6)}`;

  // 主题适配 (默认科技风深色, 传递给聚合预览区)
  const { theme, style: themeStyle } = useThemeStore();
  const isDark = theme === 'dark';
  const isPixel = themeStyle === 'pixel';

  const d = data as any;
  const providerParams = (d?.providerParams && typeof d.providerParams === 'object') ? d.providerParams : {};
  const advancedProviders = useApiKeysStore((s) => s.settings.advancedProviders);
  const videoAdvancedProviders = useMemo(
    () => advancedProvidersForNode(advancedProviders, 'video'),
    [advancedProviders],
  );
  const providerSelection = useMemo(
    () => resolveAdvancedProviderSelection(advancedProviders, 'video', {
      providerSource: d?.providerSource,
      providerId: d?.providerId,
      providerModel: d?.providerModel,
    }),
    [advancedProviders, d?.providerSource, d?.providerId, d?.providerModel],
  );
  const isExternalSelected = providerSelection.available && providerSelection.providerSource !== 'zhenzhen';
  const savedExternalMissing = !!d?.providerId
    && !!d?.providerSource
    && d.providerSource !== 'zhenzhen'
    && !providerSelection.available;
  const externalModelOptions = providerSelection.provider
    ? advancedProviderModelOptions(providerSelection.provider, 'video')
    : [];
  const externalProviderModel = providerSelection.providerModel || externalModelOptions[0] || '';
  const isAgnesExternalSelected = isExternalSelected && providerSelection.provider?.protocol === 'agnes';
  const isJimengCliSelected = isExternalSelected && providerSelection.provider?.protocol === 'jimeng-cli';
  const isJimengSeedanceSelected = isJimengCliSelected && /seedance|jimeng-video|video/i.test(externalProviderModel);
  const jimengSeedanceMode = normalizeJimengSeedanceMode(providerParams.frameMode ?? d?.jimengFrameMode);
  const jimengImageLimit = jimengSeedanceMode === 'multiframe'
    ? JIMENG_SEEDANCE_LIMITS.multiframeImages
    : JIMENG_SEEDANCE_LIMITS.images;
  const agnesFrameRate = Number(providerParams.frameRate ?? providerParams.frame_rate ?? 24) || 24;
  const agnesNumFrames = providerParams.numFrames ?? providerParams.num_frames ?? '';
  const updateProviderParams = (patch: Record<string, any>) => update({ providerParams: { ...providerParams, ...patch } });
  // 主模型 id (对应 VIDEO_MODELS 项)
  const rawModel = typeof d?.model === 'string' ? d.model : '';
  const isLegacySora2Model = /^sora-2(?:-\d{4}-\d{2}-\d{2})?$/.test(rawModel);
  const savedModelDef = VIDEO_MODELS.find(
    (model) => model.id === rawModel || model.apiModelOptions.some((option) => option.value === rawModel),
  );
  // 旧画布没有 videoBuiltinSource；根据已保存的真实模型恢复来源，避免升级后模型被静默切换。
  const inferredBuiltinSource = inferVideoBuiltinSource(rawModel || d?.mainId);
  const videoBuiltinSource: VideoBuiltinSource = d?.videoBuiltinSource === 'seedance-nz'
    || d?.videoBuiltinSource === 'zhenzhen'
    ? d.videoBuiltinSource
    : d?.providerSource === 'seedance-nz' && !d?.providerId
      ? 'seedance-nz'
      : inferredBuiltinSource || 'zhenzhen';
  const builtinVideoModels = useMemo(
    () => videoModelsForSource(videoBuiltinSource),
    [videoBuiltinSource],
  );
  const requestedMainId = d?.mainId
    || (isLegacySora2Model ? 'sora-2' : savedModelDef?.id)
    || builtinVideoModels[0]?.id
    || VIDEO_MODELS[0].id;
  const modelDef = useMemo(
    () => builtinVideoModels.find((model) => model.id === requestedMainId)
      || (savedModelDef && builtinVideoModels.find((model) => model.id === savedModelDef.id))
      || builtinVideoModels[0]
      || VIDEO_MODELS[0],
    [builtinVideoModels, requestedMainId, savedModelDef],
  );
  const mainId = modelDef.id;
  const builtinApiModelOptions = useMemo(
    () => videoModelOptionsForSource(modelDef, videoBuiltinSource),
    [modelDef, videoBuiltinSource],
  );
  // 子模型(上游真实 model 名)
  const apiModel: string = rawModel && builtinApiModelOptions.some((option) => option.value === rawModel)
    ? rawModel
    : builtinApiModelOptions[0]?.value || modelDef.apiModelOptions[0].value;
  const isHappyHorse = !isExternalSelected && modelDef.kind === 'happyhorse';
  const isHailuo = !isExternalSelected && modelDef.kind === 'hailuo';
  const isKling = !isExternalSelected && modelDef.kind === 'kling';
  const isUpscaler = !isExternalSelected && modelDef.kind === 'upscaler';
  const isVidu = !isExternalSelected && modelDef.kind === 'vidu';
  const isWan = !isExternalSelected && modelDef.kind === 'wan';
  const isApimartBudgetVideo = !isExternalSelected && isZhenzhenApimartVideoModel(apiModel);
  const isApimartOmni = apiModel === ZHENZHEN_VIDEO_G_OMNI_FLASH_MODEL;
  const isApimartGrok = apiModel === ZHENZHEN_VIDEO_GK_V15_MODEL;
  const isApimartV31Fast = apiModel === ZHENZHEN_VIDEO_V31_FAST_MODEL;
  const isApimartV31Quality = apiModel === ZHENZHEN_VIDEO_V31_QUALITY_MODEL;
  const isApimartV31Lite = apiModel === ZHENZHEN_VIDEO_V31_LITE_MODEL;
  const isApimartV31 = isApimartV31Fast || isApimartV31Quality || isApimartV31Lite;
  const happyHorseMode = apiModel.endsWith('-i2v') ? 'i2v' : apiModel.endsWith('-r2v') ? 'r2v' : 't2v';
  const hailuoMode = apiModel.includes('-i2v') ? 'i2v' : 't2v';
  const klingMode = apiModel.endsWith('-edit')
    ? 'edit'
    : apiModel.endsWith('-r2v')
      ? 'r2v'
      : apiModel.endsWith('-i2v')
        ? 'i2v'
        : 't2v';
  const viduMode = apiModel.endsWith('-short-play')
    ? 'short-play'
    : apiModel.endsWith('-start-end')
      ? 'start-end'
      : apiModel.endsWith('-r2v')
        ? 'r2v'
        : apiModel.endsWith('-i2v')
          ? 'i2v'
          : 't2v';
  const isViduUpstreamUnavailable = isVidu && (viduMode === 'r2v' || viduMode === 'short-play');
  const isKlingUpstreamUnavailable = isKling && ['kling-o3-std-r2v', 'kling-o3-pro-r2v'].includes(apiModel);
  const isSeedanceNzVideo = !isExternalSelected && videoBuiltinSource === 'seedance-nz';
  // 各参数(跳过着调用 update 默认值)
  const apimartRatioOptions = isApimartGrok
    ? ['16:9', '9:16', '1:1', '3:2', '2:3']
    : ['16:9', '9:16'];
  const rawRatio: string = d?.ratio || modelDef.defaultRatio;
  const ratio: string = isApimartBudgetVideo && !apimartRatioOptions.includes(rawRatio) ? '16:9' : rawRatio;
  const rawDuration: number = d?.duration ?? modelDef.defaultDuration ?? (modelDef.durations?.[0] || 0);
  const duration: number = isApimartV31
    ? 8
    : isApimartGrok
      ? Math.max(6, Math.min(30, Number(rawDuration) || 6))
      : isApimartOmni ? 0 : rawDuration;
  const rawResolution: string = d?.resolution || (isJimengSeedanceSelected ? '720p' : modelDef.defaultResolution || '');
  const resolution: string = isApimartOmni
    ? '720p'
    : isApimartV31 && !['720p', '1080p', '4k'].includes(rawResolution.toLowerCase())
      ? '720p'
      : isApimartGrok && !['480p', '720p'].includes(rawResolution.toLowerCase())
        ? '720p'
        : isApimartBudgetVideo ? rawResolution.toLowerCase() : rawResolution;
  const hailuoDuration: 6 | 10 = resolution === '1080p' ? 6 : Number(duration) === 10 ? 10 : 6;
  const klingDuration: 5 | 10 = Number(duration) === 10 ? 10 : 5;
  const klingNegativePrompt: string = typeof d?.klingNegativePrompt === 'string' ? d.klingNegativePrompt : '';
  const viduDuration = viduMode === 'short-play'
    ? Math.max(8, Math.min(12, Number(duration) || 8))
    : Math.max(4, Math.min(15, Number(duration) || 4));
  const viduResolution: 'default' | '720p' | '1080p' = viduMode === 'short-play'
    ? '1080p'
    : resolution === '720p' || resolution === '1080p' ? resolution : 'default';
  const viduRatio = viduMode === 'short-play'
    ? ratio === '16:9' ? '16:9' : '9:16'
    : ratio;
  const viduSeed: number = Number.isInteger(d?.viduSeed) ? d.viduSeed : -1;
  const viduScriptName: string = typeof d?.viduScriptName === 'string' ? d.viduScriptName : 'Vidu short play';
  const viduStyle: string = typeof d?.viduStyle === 'string' ? d.viduStyle : 'realistic';
  const viduAssetType: 'character' | 'scene' | 'prop' = ['character', 'scene', 'prop'].includes(d?.viduAssetType)
    ? d.viduAssetType
    : 'character';
  const viduAssetNamePrefix: string = typeof d?.viduAssetNamePrefix === 'string' ? d.viduAssetNamePrefix : 'Asset';
  const viduAssetDescription: string = typeof d?.viduAssetDescription === 'string' ? d.viduAssetDescription : 'Reference asset';
  const seed: number = typeof d?.seed === 'number' ? d.seed : 0;
  const enhancePrompt: boolean = d?.enhancePrompt ?? false;
  const enableUpsample: boolean = d?.enableUpsample ?? false;
  const wanNegativePrompt: string = typeof d?.wanNegativePrompt === 'string' ? d.wanNegativePrompt : '';
  const wanAudioUrl: string = typeof d?.wanAudioUrl === 'string' ? d.wanAudioUrl : '';
  const wanPromptExtend: boolean = d?.wanPromptExtend === true;
  const wanSeed: number = Number.isInteger(d?.wanSeed) ? d.wanSeed : -1;

  // FAL 专属参数
  const isFal = isFalVideoModel(apiModel);
  const falReg = isFal ? VIDEO_FAL_REGISTRY[apiModel] : null;
  const isGrokFalV15 = apiModel === 'grok-imagine-video-1.5';
  const isGrok15New = !isExternalSelected && isGrokVideo15NewModel(apiModel);
  const grok15NewSize = d?.size === '1280x720' || d?.size === '720x1280'
    ? d.size
    : grokVideo15NewSizeFromRatio(ratio);
  const isSoraZhenzhen = !isExternalSelected && modelDef.kind === 'sora' && !isFal;
  const isVeoOmni = !isExternalSelected && apiModel === 'veo-omni-10s';
  const showBuiltinFalControls = !isExternalSelected && isFal && !!falReg;
  const showGenericVideoControls = isExternalSelected || !isFal;
  const ratioOptions = isJimengSeedanceSelected
    ? ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9']
    : isAgnesExternalSelected
    ? ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9']
    : isApimartBudgetVideo
    ? apimartRatioOptions
    : isGrok15New
    ? ['16:9', '9:16']
    : modelDef.ratios;
  const durationOptions = isJimengSeedanceSelected
    ? [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]
    : isAgnesExternalSelected
    ? [1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 18]
    : isApimartOmni
    ? []
    : isApimartV31
    ? [8]
    : isApimartGrok
    ? Array.from({ length: 25 }, (_, index) => index + 6)
    : isGrok15New
    ? []
    : isHailuo && resolution === '1080p'
    ? [6]
    : modelDef.durations || [];
  const resolutionOptions = isJimengSeedanceSelected
    ? jimengSeedanceMode === 'multiframe'
      ? ['720p', '1080p']
      : externalProviderModel === 'seedance2.0_vip'
        ? ['720p', '1080p', '4k']
        : ['720p']
    : isAgnesExternalSelected
    ? ['480p', '720p', '1080p']
    : isApimartOmni
    ? ['720p']
    : isApimartV31
    ? ['720p', '1080p', '4k']
    : isApimartGrok
    ? ['480p', '720p']
    : isGrok15New
    ? []
    : modelDef.resolutions || [];
  // veo-fal 专属
  const vfRatio: string = d?.vfRatio || '16:9';
  const vfDuration: string = d?.vfDuration || '8s';
  const vfResolution: string = d?.vfResolution || '720p';
  const vfAudio: boolean = d?.vfAudio ?? false;
  const vfSafety: number = d?.vfSafety ?? 4;
  // grok-fal 专属
  const gkfMode: 'image_to_video' | 'reference_to_video' = isGrokFalV15
    ? 'image_to_video'
    : d?.gkfMode === 'image_to_video' ? 'image_to_video' : 'reference_to_video';
  const gkfRatio: string = d?.gkfRatio || '16:9';
  const gkfDuration: number = d?.gkfDuration ?? 6;
  const gkfResolution: string = d?.gkfResolution || '720p';
  const gkfReferenceUrls: string = d?.gkfReferenceUrls || '';
  // sora-fal 专属(图片传入默认 base64,与 gpt-image-2-web srf_imgway 默认一致)
  const soraMode: 'auto' | 'text_to_video' | 'image_to_video' = d?.soraMode || 'auto';
  const soraRatio: string = d?.soraRatio || '16:9';
  const soraDuration: number = d?.soraDuration ?? 4;
  const soraResolution: string = d?.soraResolution || '720p';
  const soraDeleteVideo: boolean = d?.soraDeleteVideo ?? true;
  const soraBlockIp: boolean = d?.soraBlockIp ?? false;
  const soraCharacterIds: string = d?.soraCharacterIds || '';
  const soraPrivate: boolean = d?.soraPrivate ?? true;

  const status: 'idle' | 'submitting' | 'polling' | 'success' | 'error' = d?.status || 'idle';
  const taskId: string | undefined = d?.taskId;
  const videoUrl: string | undefined = d?.videoUrl;
  const progress: string = d?.progress || '';
  const localPrompt: string = d?.prompt || '';
  const promptMentions: MediaMention[] = Array.isArray(d?.promptMentions) ? d.promptMentions : [];

  // === 上游素材聚合 (跨节点统一机制) ===
  const upstream = useUpstreamMaterials(id);
  const excludedMaterialIds = useMemo(
    () => normalizeExcludedMaterialIds(d?.excludedMaterialIds),
    [d?.excludedMaterialIds],
  );
  const visibleUpstreamTexts = useMemo(
    () => filterExcludedMaterials(upstream.texts, excludedMaterialIds),
    [upstream.texts, excludedMaterialIds],
  );
  const visibleUpstreamImages = useMemo(
    () => filterExcludedMaterials(upstream.images, excludedMaterialIds),
    [upstream.images, excludedMaterialIds],
  );
  const visibleUpstreamVideos = useMemo(
    () => filterExcludedMaterials(upstream.videos, excludedMaterialIds),
    [upstream.videos, excludedMaterialIds],
  );
  const visibleUpstreamAudios = useMemo(
    () => filterExcludedMaterials(upstream.audios, excludedMaterialIds),
    [upstream.audios, excludedMaterialIds],
  );
  const excludedUpstreamCount = useMemo(
    () => countExcludedMaterials(excludedMaterialIds, [...upstream.texts, ...upstream.images, ...upstream.videos, ...upstream.audios]),
    [excludedMaterialIds, upstream.texts, upstream.images, upstream.videos, upstream.audios],
  );
  const materialOrder: string[] = Array.isArray(d?.materialOrder) ? d.materialOrder : [];
  const orderedTexts = useOrderedMaterials(visibleUpstreamTexts, materialOrder);
  const orderedImages = useOrderedMaterials(visibleUpstreamImages, materialOrder);
  const orderedVideos = useOrderedMaterials(visibleUpstreamVideos, materialOrder);
  const orderedAudios = useOrderedMaterials(visibleUpstreamAudios, materialOrder);
  const setMaterialOrder = (newOrder: string[]) => update({ materialOrder: newOrder });
  const handleExcludeUpstreamMaterial = (m: Material) => {
    if (m.origin !== 'upstream') return;
    update({
      excludedMaterialIds: excludeMaterialId(excludedMaterialIds, m.id),
      materialOrder: materialOrder.filter((itemId) => itemId !== m.id),
    });
  };
  const handleRestoreExcludedMaterials = () => update({ excludedMaterialIds: [] });

  // === 本地拖入参考素材 (跨节点 Ctrl 拖拽) ===
  const localRefImages: string[] = Array.isArray(d?.localRefImages) ? d.localRefImages : [];
  const localRefVideos: string[] = Array.isArray(d?.localRefVideos) ? d.localRefVideos : [];
  const localRefAudios: string[] = Array.isArray(d?.localRefAudios) ? d.localRefAudios : [];
  const localRefMaterials: Material[] = useMemo(
    () => [
      ...localRefImages.map((url, i) => ({
        id: `local::video-image:${url}`,
        kind: 'image' as const,
        url,
        sourceNodeId: id,
        origin: 'local' as const,
        label: `本地图片${i + 1}`,
      })),
      ...localRefVideos.map((url, i) => ({
        id: `local::video-video:${url}`,
        kind: 'video' as const,
        url,
        sourceNodeId: id,
        origin: 'local' as const,
        label: `本地视频${i + 1}`,
      })),
      ...localRefAudios.map((url, i) => ({
        id: `local::video-audio:${url}`,
        kind: 'audio' as const,
        url,
        sourceNodeId: id,
        origin: 'local' as const,
        label: `本地音频${i + 1}`,
      })),
    ],
    [localRefImages, localRefVideos, localRefAudios, id],
  );
  const maxMentionRefs =
    isUpscaler
      ? 0
      : isWan
      ? 1
      : isKling
      ? klingMode === 'i2v' ? 2 : klingMode === 'r2v' ? 4 : 0
      : isVidu
      ? viduMode === 't2v' ? 0 : viduMode === 'i2v' ? 1 : viduMode === 'start-end' ? 2 : viduMode === 'r2v' ? 9 : 14
      : isHailuo
      ? hailuoMode === 't2v' ? 0 : 1
      : isHappyHorse
      ? happyHorseMode === 't2v' ? 0 : happyHorseMode === 'i2v' ? 1 : 9
      : isApimartOmni
      ? 16
      : isApimartGrok
      ? 7
      : isApimartV31Fast
      ? 3
      : isApimartV31Quality
      ? 2
      : isApimartV31Lite
      ? 0
      : isVeoOmni
      ? 1
      : isGrok15New
      ? 1
      : isJimengSeedanceSelected
      ? jimengImageLimit
      : isFal && falReg
      ? falReg.paramKind === 'grok-fal' && (isGrokFalV15 || gkfMode !== 'reference_to_video')
        ? 1
        : falReg.maxRefImages
      : modelDef.maxRefImages;
  const maxMentionVideos = isUpscaler
    ? 1
    : isKling && klingMode === 'edit'
    ? 1
    : isApimartOmni
    ? 1
    : isJimengSeedanceSelected ? JIMENG_SEEDANCE_LIMITS.videos : 0;
  const maxMentionAudios = isJimengSeedanceSelected ? JIMENG_SEEDANCE_LIMITS.audios : 0;
  const mentionMaterials = useMemo(
    () => [
      ...[...orderedImages, ...localRefMaterials.filter((m) => m.kind === 'image')].slice(0, maxMentionRefs),
      ...[...orderedVideos, ...localRefMaterials.filter((m) => m.kind === 'video')].slice(0, maxMentionVideos),
      ...[...orderedAudios, ...localRefMaterials.filter((m) => m.kind === 'audio')].slice(0, maxMentionAudios),
    ],
    [orderedImages, orderedVideos, orderedAudios, localRefMaterials, maxMentionRefs, maxMentionVideos, maxMentionAudios],
  );

  // 分组动态跟随子模型: Seedance / 即梦 CLI 支持 image/video/audio, 其他 (grok/veo/sora) 仅 image
  const previewGroups = useMemo<ReadonlyArray<'text' | 'image' | 'video' | 'audio'>>(
    () => (modelDef.kind === 'seedance' || isJimengSeedanceSelected
      ? ['text', 'image', 'video', 'audio']
      : isApimartOmni
        ? ['text', 'image', 'video']
      : isUpscaler
        ? ['video']
      : isKling && klingMode === 'edit'
        ? ['text', 'video']
        : ['text', 'image']),
    [modelDef.kind, isJimengSeedanceSelected, isApimartOmni, isUpscaler, isKling, klingMode],
  );

  // 收集上游 prompt + 参考图/视频/音频 (按用户拖拽顺序), 合并本地拖入素材
  const collectUpstream = (): { prompt: string; imageUrls: string[]; videoUrls: string[]; audioUrls: string[] } => {
    const prompts = orderedTexts.map((t) => t.url).filter((s) => !!s);
    const upImageUrls = orderedImages.map((m) => m.url).filter((s) => !!s);
    const upVideoUrls = orderedVideos.map((m) => m.url).filter((s) => !!s);
    const upAudioUrls = orderedAudios.map((m) => m.url).filter((s) => !!s);
    const dedupe = (items: string[]) => {
      const out: string[] = [];
      for (const item of items) if (item && !out.includes(item)) out.push(item);
      return out;
    };
    return {
      prompt: prompts.join('\n').trim(),
      imageUrls: dedupe([...upImageUrls, ...localRefImages]),
      videoUrls: dedupe([...upVideoUrls, ...localRefVideos]),
      audioUrls: dedupe([...upAudioUrls, ...localRefAudios]),
    };
  };

  // 本地 URL 转 base64(veo/seedance 路径使用;grok 可直接传 URL)
  const urlToBase64 = async (url: string): Promise<string> => {
    const r = await fetch(url);
    const blob = await r.blob();
    return new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  };

  const stopPoll = () => {
    if (pollTimer.current) {
      window.clearInterval(pollTimer.current);
      pollTimer.current = null;
    }
  };

  const nextGenerationRun = () => {
    generationRunRef.current += 1;
    return generationRunRef.current;
  };
  const isCurrentGenerationRun = (runId: number) => generationRunRef.current === runId;
  const rejectStoppedGeneration = (reject: (reason?: any) => void) => {
    if (pollRejectRef.current === reject) {
      pollRejectRef.current = null;
      stopPoll();
    }
    reject(new Error('用户已停止生成'));
  };
  const cancelActivePoll = () => {
    const reject = pollRejectRef.current;
    pollRejectRef.current = null;
    stopPoll();
    if (reject) reject(new Error('用户已停止生成'));
  };

  useEffect(() => () => cancelActivePoll(), []);

  // 切主模型时重置所有参数为该模型默认值(避免跨模型参数遗留)
  const switchMainModel = (nextId: string) => {
    const def = builtinVideoModels.find((model) => model.id === nextId) || builtinVideoModels[0] || VIDEO_MODELS[0];
    const nextModel = videoModelOptionsForSource(def, videoBuiltinSource)[0]?.value || def.apiModelOptions[0].value;
    update({
      mainId: def.id,
      model: nextModel,
      videoBuiltinSource,
      ratio: def.defaultRatio,
      duration: def.defaultDuration ?? def.durations?.[0],
      resolution: def.defaultResolution || '',
      ...(nextModel === 'grok-imagine-video-1.5' ? { gkfMode: 'image_to_video' } : {}),
      ...(isGrokVideo15NewModel(nextModel) ? { ratio: '16:9', resolution: '' } : {}),
      ...(nextModel.startsWith('vidu-q3-') ? { viduSeed: -1 } : {}),
    });
  };

  const switchBuiltinVideoSource = (nextSource: VideoBuiltinSource) => {
    const nextModels = videoModelsForSource(nextSource);
    const nextDef = nextModels.find((model) => model.id === modelDef.id) || nextModels[0] || VIDEO_MODELS[0];
    const nextModel = videoModelOptionsForSource(nextDef, nextSource)[0]?.value || nextDef.apiModelOptions[0].value;
    update({
      providerSource: 'zhenzhen',
      providerId: '',
      providerModel: '',
      videoBuiltinSource: nextSource,
      mainId: nextDef.id,
      model: nextModel,
      ratio: nextDef.defaultRatio,
      duration: nextDef.defaultDuration ?? nextDef.durations?.[0],
      resolution: nextDef.defaultResolution || '',
      ...(nextModel === ZHENZHEN_VIDEO_G_OMNI_FLASH_MODEL
        ? { ratio: '16:9', duration: 0, resolution: '720p' }
        : {}),
      ...(nextModel === ZHENZHEN_VIDEO_GK_V15_MODEL
        ? { ratio: '16:9', duration: 6, resolution: '720p' }
        : {}),
      ...(nextModel === ZHENZHEN_VIDEO_V31_FAST_MODEL
        || nextModel === ZHENZHEN_VIDEO_V31_QUALITY_MODEL
        || nextModel === ZHENZHEN_VIDEO_V31_LITE_MODEL
        ? { ratio: '16:9', duration: 8, resolution: '720p' }
        : {}),
      ...(nextModel === 'grok-imagine-video-1.5' ? { gkfMode: 'image_to_video' } : {}),
      ...(isGrokVideo15NewModel(nextModel) ? { ratio: '16:9', size: '1280x720', resolution: '' } : {}),
      ...(nextModel.startsWith('vidu-q3-') ? { viduSeed: -1 } : {}),
    });
  };

  // v1.2.9.11: 返回 Promise，调用方 await 直到任务真正成功/失败/超时才 resolve/reject。
  //   原设计中 startPolling 启动 setInterval 后立即返回 → handleGenerate 提交成功后也立即返回 →
  //   useRunTrigger 认为 runFn 完成 markDone(true)。 但实际任务 videoUrl 还未赋值 → LoopNode awaitNode
  //   立即继续 → extractFromNode 读不到 videoUrl → result=null → failCount++。
  //   修复: 轮询完成才 resolve，handleGenerate await 它，markDone 时机=任务真正结束。
  const startPolling = (tid: string, runId: number, reporter?: RunNodeLifecycleReporter): Promise<void> => {
    stopPoll();
    return new Promise<void>((resolve, reject) => {
      pollRejectRef.current = reject;
      let elapsed = 0;
      const POLL_INT = VIDEO_POLL_INTERVAL_MS;
      const MAX = VIDEO_MAX_POLL; // 60 分钟
      let lastProgress = '';
      let pollInFlight = false;
      pollTimer.current = window.setInterval(async () => {
        if (pollInFlight) return;
        elapsed += 1;
        if (!isCurrentGenerationRun(runId)) {
          rejectStoppedGeneration(reject);
          return;
        }
        if (elapsed > MAX) {
          pollRejectRef.current = null;
          stopPoll();
          update({ status: 'error', error: '轮询超时' });
          setError('轮询超时');
          logBus.error('轮询超时', src);
          reject(new Error('轮询超时'));
          return;
        }
        pollInFlight = true;
        try {
          const r = isWan
            ? await queryWan(tid)
            : isHailuo
              ? await queryHailuo(tid)
            : isKling
              ? await queryKling(tid)
            : isUpscaler
              ? await queryUpscaler(tid)
            : isVidu
              ? await queryVidu(tid)
            : isHappyHorse
              ? await queryHappyHorse(tid)
            : isApimartBudgetVideo
              ? await querySeedance(tid, 'seedance-nz')
              : await queryVideo(tid, apiModel);
          const normalizedStatus = String(r.status || '').trim().toUpperCase();
          const currentProgress = String(r.progress ?? '');
          await reporter?.polling({
            provider: isSeedanceNzVideo ? 'seedance-nz' : 'zhenzhen',
            model: apiModel,
            taskId: tid,
            recovery: {
              kind: isWan ? 'wan' : isHailuo ? 'hailuo' : isKling ? 'kling' : isUpscaler ? 'upscaler' : isVidu ? 'vidu' : isHappyHorse ? 'happyhorse' : isApimartBudgetVideo ? 'seedance' : 'video',
              taskId: tid, model: apiModel, pollIntervalMs: POLL_INT, maxPolls: MAX,
            },
            requestId: r.requestId,
            transportHttpStatus: r.transportHttpStatus,
            upstreamHttpStatus: r.upstreamHttpStatus,
            usage: r.usage,
            httpStatusSource: 'local-backend',
            pollCount: elapsed,
            pollLimit: MAX,
            status: normalizedStatus,
            progress: currentProgress,
          });
          if (!isCurrentGenerationRun(runId)) {
            rejectStoppedGeneration(reject);
            return;
          }
          if (currentProgress && currentProgress !== lastProgress) {
            lastProgress = currentProgress;
            logBus.debug(`[${elapsed}/${MAX}] status=${r.status} progress=${currentProgress}`, src);
          }
          if (normalizedStatus === 'MATERIALIZING') {
            update({ status: 'polling', progress: '100% · 正在下载' });
            if (elapsed === 1 || elapsed % 10 === 0) {
              logBus.warn(
                r.error || '视频已经生成，正在适配 TUN/代理网络并安全下载；原任务会保留，不会重复提交',
                src,
              );
            }
          } else if (['SUCCESS', 'SUCCEEDED', 'COMPLETED'].includes(normalizedStatus) && r.videoUrl) {
            pollRejectRef.current = null;
            stopPoll();
            update({
              status: 'success',
              videoUrl: r.videoUrl,
              progress: '100%',
              provider: isSeedanceNzVideo ? 'seedance-nz' : 'zhenzhen',
              apiModel,
              taskId: tid,
              requestId: r.requestId,
              transportHttpStatus: r.transportHttpStatus,
              upstreamHttpStatus: r.upstreamHttpStatus,
              usage: r.usage,
              pollCount: elapsed,
            });
            await reporter?.providerResponse({
              provider: isSeedanceNzVideo ? 'seedance-nz' : 'zhenzhen',
              model: apiModel,
              upstreamTaskId: tid,
              requestId: r.requestId,
              transportHttpStatus: r.transportHttpStatus,
              upstreamHttpStatus: r.upstreamHttpStatus,
              usage: r.usage,
              pollCount: elapsed,
              status: 'succeeded',
              httpStatusSource: 'local-backend',
            });
            logBus.success(`任务完成 → ${r.videoUrl}`, src);
            taskCompletionSound.notifyComplete(id, 'video');
            resolve();
          } else if (['FAILURE', 'FAILED'].includes(normalizedStatus)) {
            pollRejectRef.current = null;
            stopPoll();
            const msg = normalizeProviderErrorMessage(r.failReason, '生成失败');
            await reporter?.providerResponse({
              provider: isSeedanceNzVideo ? 'seedance-nz' : 'zhenzhen',
              model: apiModel,
              upstreamTaskId: tid,
              requestId: r.requestId,
              transportHttpStatus: r.transportHttpStatus,
              upstreamHttpStatus: r.upstreamHttpStatus,
              usage: r.usage,
              pollCount: elapsed,
              status: 'failed',
              error: { message: msg },
              httpStatusSource: 'local-backend',
            });
            update({ status: 'error', error: msg });
            setError(msg);
            logBus.error(`生成失败: ${msg}`, src);
            reject(new Error(msg));
          } else {
            update({ status: 'polling', progress: currentProgress });
          }
        } catch (e: any) {
          if (!isCurrentGenerationRun(runId)) {
            rejectStoppedGeneration(reject);
            return;
          }
          // 偶尔失败不停止
          console.warn('轮询出错', e?.message);
        } finally {
          pollInFlight = false;
        }
      }, POLL_INT);
    });
  };

  // FAL 轮询
  const falPollRef = useRef<{ endpoint?: string; requestId?: string } | null>(null);

  // v1.2.9.11: 同样改造为 Promise（理由同 startPolling）
  const startFalPolling = (runId: number, reporter?: RunNodeLifecycleReporter): Promise<void> => {
    stopPoll();
    return new Promise<void>((resolve, reject) => {
      pollRejectRef.current = reject;
      let elapsed = 0;
      const POLL_INT = VIDEO_FAL_POLL_INTERVAL_MS;
      const MAX = VIDEO_FAL_MAX_POLL; // 60分钟
      let pollInFlight = false;
      pollTimer.current = window.setInterval(async () => {
        if (pollInFlight) return;
        elapsed += 1;
        if (!isCurrentGenerationRun(runId)) {
          rejectStoppedGeneration(reject);
          return;
        }
        if (elapsed > MAX) {
          pollRejectRef.current = null;
          stopPoll();
          update({ status: 'error', error: 'FAL 轮询超时' });
          setError('FAL 轮询超时');
          logBus.error('FAL 轮询超时', src);
          reject(new Error('FAL 轮询超时'));
          return;
        }
        pollInFlight = true;
        try {
          const r = await queryVideoFal(falPollRef.current!);
          await reporter?.polling({
            provider: 'fal',
            model: apiModel,
            requestId: falPollRef.current?.requestId || null,
            recovery: {
              kind: 'video-fal',
              requestId: falPollRef.current?.requestId || null,
              endpoint: falPollRef.current?.endpoint,
              model: apiModel,
              pollIntervalMs: POLL_INT,
              maxPolls: MAX,
            },
            transportHttpStatus: r.transportHttpStatus,
            upstreamHttpStatus: r.upstreamHttpStatus,
            usage: r.usage,
            httpStatusSource: 'local-backend',
            pollCount: elapsed,
            pollLimit: MAX,
            status: r.status,
          });
          if (!isCurrentGenerationRun(runId)) {
            rejectStoppedGeneration(reject);
            return;
          }
          if (elapsed % 10 === 0) logBus.debug(`[FAL ${elapsed}/${MAX}] status=${r.status}`, src);
          if (String(r.status || '').toLowerCase() === 'materializing') {
            update({ status: 'polling', progress: '100% · 正在下载' });
            if (elapsed === 1 || elapsed % 10 === 0) {
              logBus.warn(
                r.error || 'FAL 视频已经生成，正在适配 TUN/代理网络并安全下载；不会重复提交任务',
                src,
              );
            }
          } else if (r.status === 'completed' && r.videoUrl) {
            pollRejectRef.current = null;
            stopPoll();
            update({
              status: 'success',
              videoUrl: r.videoUrl,
              progress: '100%',
              provider: 'fal',
              apiModel,
              requestId: r.requestId || falPollRef.current?.requestId,
              transportHttpStatus: r.transportHttpStatus,
              upstreamHttpStatus: r.upstreamHttpStatus,
              usage: r.usage,
              pollCount: elapsed,
            });
            await reporter?.providerResponse({
              provider: 'fal',
              model: apiModel,
              requestId: r.requestId || falPollRef.current?.requestId,
              transportHttpStatus: r.transportHttpStatus,
              upstreamHttpStatus: r.upstreamHttpStatus,
              usage: r.usage,
              pollCount: elapsed,
              status: 'succeeded',
              httpStatusSource: 'local-backend',
            });
            logBus.success(`FAL 视频完成 → ${r.videoUrl}`, src);
            taskCompletionSound.notifyComplete(id, 'video');
            resolve();
          } else if (r.status === 'failed') {
            pollRejectRef.current = null;
            stopPoll();
            const msg = normalizeProviderErrorMessage(r.error, 'FAL 生成失败');
            await reporter?.providerResponse({
              provider: 'fal',
              model: apiModel,
              requestId: r.requestId || falPollRef.current?.requestId,
              transportHttpStatus: r.transportHttpStatus,
              upstreamHttpStatus: r.upstreamHttpStatus,
              usage: r.usage,
              pollCount: elapsed,
              status: 'failed',
              error: { message: msg },
              httpStatusSource: 'local-backend',
            });
            update({ status: 'error', error: msg });
            setError(msg);
            logBus.error(`FAL 生成失败: ${msg}`, src);
            reject(new Error(msg));
          } else {
            update({ status: 'polling', progress: `${Math.min(95, Math.round(20 + elapsed / MAX * 75))}%` });
          }
        } catch (e: any) {
          if (!isCurrentGenerationRun(runId)) {
            rejectStoppedGeneration(reject);
            return;
          }
          console.warn('FAL 轮询出错', e?.message);
        } finally {
          pollInFlight = false;
        }
      }, POLL_INT);
    });
  };

  const handleGenerate = async (reporter?: RunNodeLifecycleReporter) => {
    setError(null);
    const { prompt: upstreamPrompt, imageUrls, videoUrls, audioUrls } = collectUpstream();
    const resolvedLocalPrompt = resolveMediaMentions(localPrompt, promptMentions, mentionMaterials);
    const finalPrompt = (upstreamPrompt || resolvedLocalPrompt || '').trim();
    if (
      !finalPrompt
      && !isWan
      && !isUpscaler
      && !(isHappyHorse && happyHorseMode !== 't2v')
      && !(isHailuo && hailuoMode === 'i2v')
      && !(isKling && klingMode === 'i2v')
      && !(isVidu && !['t2v', 'short-play'].includes(viduMode))
      && !(isApimartOmni && (imageUrls.length > 0 || videoUrls.length > 0))
    ) {
      setError('未连接 text 节点也未填写 prompt');
      logBus.error('生成中止: 缺少 prompt', src);
      return;
    }
    if (isHappyHorse && happyHorseMode !== 't2v' && imageUrls.length === 0) {
      setError(`Happy Horse ${happyHorseMode} 至少需要 1 张参考图`);
      logBus.error(`生成中止: Happy Horse ${happyHorseMode} 缺少参考图`, src);
      return;
    }
    if (isHailuo && hailuoMode === 'i2v' && imageUrls.length === 0) {
      setError('Hailuo 2.3 图生视频必须连接或拖入 1 张首帧图');
      logBus.error('生成中止: Hailuo 2.3 图生视频缺少首帧图', src);
      return;
    }
    if (isKling && klingMode === 'i2v' && imageUrls.length === 0) {
      setError('Kling 图生视频必须连接或拖入第 1 张首帧图');
      logBus.error('生成中止: Kling 图生视频缺少首帧图', src);
      return;
    }
    if (isKlingUpstreamUnavailable) {
      setError('该 Kling O3 参考生视频模型已按官方协议接入，但参考插件当前实测上游提交返回 502，暂时禁用以避免无效请求');
      logBus.error('生成中止: Kling O3 参考生视频上游当前不可用', src);
      return;
    }
    if (isKling && klingMode === 'r2v' && imageUrls.length === 0) {
      setError('Kling 参考生视频至少需要 1 张参考图');
      logBus.error('生成中止: Kling 参考生视频缺少参考图', src);
      return;
    }
    if (isKling && klingMode === 'edit' && videoUrls.length === 0) {
      setError('Kling 视频编辑必须连接或拖入 1 个输入视频');
      logBus.error('生成中止: Kling 视频编辑缺少输入视频', src);
      return;
    }
    if (isUpscaler && videoUrls.length !== 1) {
      setError('Zhenzhen Upscaler 必须连接或拖入且只能保留 1 个 MP4 视频');
      logBus.error('生成中止: Zhenzhen Upscaler 输入视频数量必须为 1', src);
      return;
    }
    if (isViduUpstreamUnavailable) {
      setError('该 Vidu Q3 模型已按官方协议接入，但当前上游提交返回 fail_to_fetch_task，暂时禁用以避免无效请求');
      logBus.error('生成中止: Vidu Q3 上游当前不可用', src);
      return;
    }
    if (isVidu && viduMode === 'i2v' && imageUrls.length === 0) {
      setError('Vidu Q3 图生视频必须连接或拖入第 1 张首帧图');
      logBus.error('生成中止: Vidu Q3 图生视频缺少首帧图', src);
      return;
    }
    if (isVidu && viduMode === 'start-end' && imageUrls.length < 2) {
      setError('Vidu Q3 首尾帧视频必须连接或拖入起始帧和结束帧两张图片');
      logBus.error('生成中止: Vidu Q3 首尾帧视频缺少两张图片', src);
      return;
    }
    if (isVidu && viduMode === 'r2v' && imageUrls.length === 0) {
      setError('Vidu Q3 参考生视频至少需要 1 张参考图');
      logBus.error('生成中止: Vidu Q3 参考生视频缺少参考图', src);
      return;
    }
    if (isVidu && viduMode === 'short-play') {
      if (imageUrls.length === 0) {
        setError('Vidu Q3 短剧成片至少需要 1 张参考资产图');
        logBus.error('生成中止: Vidu Q3 短剧成片缺少参考资产图', src);
        return;
      }
      if (!viduScriptName.trim()) {
        setError('Vidu Q3 短剧成片必须填写脚本名称');
        logBus.error('生成中止: Vidu Q3 短剧成片缺少脚本名称', src);
        return;
      }
      if (!viduAssetNamePrefix.trim() || !viduAssetDescription.trim()) {
        setError('Vidu Q3 短剧资产名称前缀和描述不能为空');
        logBus.error('生成中止: Vidu Q3 短剧资产信息不完整', src);
        return;
      }
    }
    if (isWan && imageUrls.length === 0) {
      setError('Wan 2.7 Spicy 必须连接或拖入 1 张首帧图');
      logBus.error('生成中止: Wan 2.7 Spicy 缺少首帧图', src);
      return;
    }
    if (isVeoOmni && imageUrls.length === 0) {
      setError('veo-omni-10s 需要 1 张参考图');
      logBus.error('生成中止: veo-omni-10s 缺少参考图', src);
      return;
    }
    if (isGrok15New && imageUrls.length === 0) {
      setError('Grok 1.5 New 需要 1 张参考图');
      logBus.error('生成中止: Grok 1.5 New 缺少参考图', src);
      return;
    }
    const runId = nextGenerationRun();
    cancelActivePoll();
    falPollRef.current = null;
    const traceProvider = isExternalSelected && providerSelection.provider
      ? providerSelection.provider.id
      : isFal
        ? 'fal'
        : isSeedanceNzVideo
          ? 'seedance-nz'
          : 'zhenzhen';
    const traceModel = isExternalSelected && providerSelection.provider ? externalProviderModel : apiModel;
    await reporter?.providerRequest({ provider: traceProvider, model: traceModel });
    taskCompletionSound.primeAudio();
    update({ status: 'submitting', error: null, videoUrl: null, taskId: null });
    try {
      if (isExternalSelected && providerSelection.provider) {
        const providerModel = externalProviderModel;
        const refs = imageUrls.slice(0, Math.max(1, maxMentionRefs || modelDef.maxRefImages || 8));
        const videoRefs = videoUrls.slice(0, maxMentionVideos);
        const audioRefs = audioUrls.slice(0, maxMentionAudios);
        logBus.info(
          isJimengSeedanceSelected
            ? `扩展平台视频提交: ${providerSelection.provider.label || providerSelection.provider.id} · ${providerModel} · 图${refs.length}/视${videoRefs.length}/音${audioRefs.length}`
            : `扩展平台视频提交: ${providerSelection.provider.label || providerSelection.provider.id} · ${providerModel} · refs=${refs.length}`,
          src,
        );
        const r = await generateExternalVideo({
          providerId: providerSelection.provider.id,
          providerModel,
          model: providerModel,
          prompt: finalPrompt,
          aspect_ratio: ratio,
          ratio,
          duration,
          resolution,
          seed: seed > 0 ? seed : undefined,
          images: refs,
          videos: videoRefs,
          audios: audioRefs,
          providerParams: isJimengSeedanceSelected
            ? { ...providerParams, frameMode: jimengSeedanceMode }
            : providerParams,
        }, { submissionKey: reporter?.providerSubmissionKey });
        if (!isCurrentGenerationRun(runId)) return;
        const nextVideoUrl = r.videoUrls[0];
        if (!nextVideoUrl) throw new Error('扩展平台没有返回视频。');
        if (r.taskId || r.requestId) {
          await reporter?.providerSubmitted({
            provider: traceProvider,
            model: traceModel,
            upstreamTaskId: r.taskId,
            requestId: r.requestId,
            transportHttpStatus: r.transportHttpStatus,
            upstreamHttpStatus: r.upstreamHttpStatus,
            usage: r.usage,
            httpStatusSource: 'local-backend',
          });
        }
        await reporter?.providerResponse({
          provider: traceProvider,
          model: traceModel,
          upstreamTaskId: r.taskId,
          requestId: r.requestId,
          transportHttpStatus: r.transportHttpStatus,
          upstreamHttpStatus: r.upstreamHttpStatus,
          usage: r.usage,
          status: 'succeeded',
          httpStatusSource: 'local-backend',
        });
        update({
          status: 'success',
          videoUrl: nextVideoUrl,
          videoUrls: r.videoUrls,
          remoteVideoUrls: r.remoteVideoUrls,
          taskId: r.taskId || null,
          provider: traceProvider,
          apiModel: traceModel,
          requestId: r.requestId,
          transportHttpStatus: r.transportHttpStatus,
          upstreamHttpStatus: r.upstreamHttpStatus,
          usage: r.usage,
          lastPrompt: finalPrompt,
          progress: '100%',
        });
        logBus.success(`扩展平台视频完成 → ${nextVideoUrl}`, src);
        taskCompletionSound.notifyComplete(id, 'video');
        return;
      }

      if (isApimartBudgetVideo) {
        const apimartImages = imageUrls.slice(0, maxMentionRefs);
        const apimartVideos = isApimartOmni ? videoUrls.slice(0, 1) : [];
        logBus.info(
          `提交平价AI小屋视频: ${apiModel} · ${isApimartOmni ? '时长由模型决定' : `${duration}s`} · ${resolution} · ${ratio} · 图${apimartImages.length}/视${apimartVideos.length}`,
          src,
        );
        const result = await submitSeedance({
          model: apiModel,
          prompt: finalPrompt,
          duration: isApimartOmni ? undefined : duration,
          ratio,
          resolution,
          refImages: apimartImages.length ? apimartImages : undefined,
          videos: apimartVideos.length ? apimartVideos : undefined,
          taskProvider: 'seedance-nz',
        }, { submissionKey: reporter?.providerSubmissionKey });
        if (!isCurrentGenerationRun(runId)) return;
        await reporter?.providerSubmitted({
          provider: traceProvider,
          model: traceModel,
          upstreamTaskId: result.taskId,
          requestId: result.requestId,
          transportHttpStatus: result.transportHttpStatus,
          upstreamHttpStatus: result.upstreamHttpStatus,
          usage: result.usage,
          httpStatusSource: 'local-backend',
        });
        update({
          status: 'polling',
          taskId: result.taskId,
          lastPrompt: finalPrompt,
          progress: '0%',
          provider: 'seedance-nz',
          apiModel,
        });
        logBus.info(`平价AI小屋视频任务 ${result.taskId} 已提交，开始轮询`, src);
        await startPolling(result.taskId, runId, reporter);
        return;
      }

      if (isWan) {
        const firstImage = imageUrls[0];
        logBus.info(
          `提交 Wan 2.7 Spicy: ${apiModel} · ${duration}s · ${resolution || '720p'} · promptExtend=${wanPromptExtend}`,
          src,
        );
        const result = await submitWan({
          model: 'wan-2.7-spicy-i2v',
          prompt: finalPrompt || undefined,
          duration: Number(duration) || 2,
          resolution: resolution === '1080p' ? '1080p' : '720p',
          images: [firstImage],
          negativePrompt: wanNegativePrompt.trim() || undefined,
          audioUrl: wanAudioUrl.trim() || undefined,
          promptExtend: wanPromptExtend,
          seed: wanSeed,
        }, { submissionKey: reporter?.providerSubmissionKey });
        if (!isCurrentGenerationRun(runId)) return;
        await reporter?.providerSubmitted({
          provider: traceProvider,
          model: traceModel,
          upstreamTaskId: result.taskId,
          requestId: result.requestId,
          transportHttpStatus: result.transportHttpStatus,
          upstreamHttpStatus: result.upstreamHttpStatus,
          usage: result.usage,
          httpStatusSource: 'local-backend',
        });
        update({ status: 'polling', taskId: result.taskId, lastPrompt: finalPrompt, progress: '0%' });
        logBus.info(`Wan 2.7 Spicy 任务 ${result.taskId} 已提交，开始轮询`, src);
        await startPolling(result.taskId, runId, reporter);
        return;
      }

      if (isHailuo) {
        const hailuoImages = hailuoMode === 'i2v' ? imageUrls.slice(0, 1) : [];
        logBus.info(
          `提交 Hailuo 2.3: ${apiModel} · ${hailuoDuration}s · ${resolution || '768p'} · ${hailuoMode === 't2v' ? ratio : 'follow-image'} · refs=${hailuoImages.length}`,
          src,
        );
        const result = await submitHailuo({
          model: apiModel as Hailuo23Model,
          prompt: finalPrompt || undefined,
          duration: hailuoDuration,
          ratio,
          resolution: resolution === '1080p' ? '1080p' : '768p',
          images: hailuoImages.length ? hailuoImages : undefined,
        }, { submissionKey: reporter?.providerSubmissionKey });
        if (!isCurrentGenerationRun(runId)) return;
        await reporter?.providerSubmitted({
          provider: traceProvider,
          model: traceModel,
          upstreamTaskId: result.taskId,
          requestId: result.requestId,
          transportHttpStatus: result.transportHttpStatus,
          upstreamHttpStatus: result.upstreamHttpStatus,
          usage: result.usage,
          httpStatusSource: 'local-backend',
        });
        update({ status: 'polling', taskId: result.taskId, lastPrompt: finalPrompt, progress: '0%' });
        logBus.info(`Hailuo 2.3 任务已提交，开始轮询`, src);
        await startPolling(result.taskId, runId, reporter);
        return;
      }

      if (isKling) {
        const klingImages = klingMode === 'i2v'
          ? imageUrls.slice(0, 2)
          : klingMode === 'r2v' ? imageUrls.slice(0, 4) : [];
        const klingVideos = klingMode === 'edit' ? videoUrls.slice(0, 1) : [];
        logBus.info(
          `提交 Kling: ${apiModel} · ${klingDuration}s · ${klingMode === 'edit' ? 'video-edit' : ratio} · refs=${klingImages.length} · videos=${klingVideos.length}`,
          src,
        );
        const result = await submitKling({
          model: apiModel as KlingModel,
          prompt: finalPrompt || undefined,
          duration: klingDuration,
          ...(klingMode === 'edit'
            ? { videos: klingVideos }
            : {
                ratio,
                negativePrompt: klingNegativePrompt.trim() || undefined,
                images: klingImages.length ? klingImages : undefined,
              }),
        }, { submissionKey: reporter?.providerSubmissionKey });
        if (!isCurrentGenerationRun(runId)) return;
        await reporter?.providerSubmitted({
          provider: traceProvider,
          model: traceModel,
          upstreamTaskId: result.taskId,
          requestId: result.requestId,
          transportHttpStatus: result.transportHttpStatus,
          upstreamHttpStatus: result.upstreamHttpStatus,
          usage: result.usage,
          httpStatusSource: 'local-backend',
        });
        update({ status: 'polling', taskId: result.taskId, lastPrompt: finalPrompt, progress: '0%' });
        logBus.info('Kling 任务已提交，开始轮询', src);
        await startPolling(result.taskId, runId, reporter);
        return;
      }

      if (isUpscaler) {
        const targetResolution: UpscalerResolution = ['720p', '1080p', '2k', '4k'].includes(resolution)
          ? resolution as UpscalerResolution
          : '1080p';
        logBus.info(`提交 Zhenzhen Upscaler: ${targetResolution} · videos=1`, src);
        const result = await submitUpscaler({
          model: 'zhenzhen-upscaler',
          resolution: targetResolution,
          videos: [videoUrls[0]],
        }, { submissionKey: reporter?.providerSubmissionKey });
        if (!isCurrentGenerationRun(runId)) return;
        await reporter?.providerSubmitted({
          provider: traceProvider,
          model: traceModel,
          upstreamTaskId: result.taskId,
          requestId: result.requestId,
          transportHttpStatus: result.transportHttpStatus,
          upstreamHttpStatus: result.upstreamHttpStatus,
          usage: result.usage,
          httpStatusSource: 'local-backend',
        });
        update({ status: 'polling', taskId: result.taskId, lastPrompt: '', progress: '0%' });
        logBus.info('Zhenzhen Upscaler 任务已提交，开始轮询', src);
        await startPolling(result.taskId, runId, reporter);
        return;
      }

      if (isVidu) {
        const viduImages = viduMode === 't2v'
          ? []
          : imageUrls.slice(0, viduMode === 'i2v' ? 1 : viduMode === 'start-end' ? 2 : viduMode === 'r2v' ? 9 : 14);
        logBus.info(
          `提交 Vidu Q3: ${apiModel} · ${viduDuration}s · ${viduResolution} · ${viduRatio} · refs=${viduImages.length}`,
          src,
        );
        const result = await submitVidu({
          model: apiModel as ViduQ3Model,
          prompt: finalPrompt || undefined,
          duration: viduDuration,
          ratio: viduRatio,
          resolution: viduResolution,
          seed: viduSeed,
          images: viduImages.length ? viduImages : undefined,
          ...(viduMode === 'short-play'
            ? {
                scriptName: viduScriptName.trim(),
                style: viduStyle.trim(),
                assetType: viduAssetType,
                assetNamePrefix: viduAssetNamePrefix.trim(),
                assetDescription: viduAssetDescription.trim(),
              }
            : {}),
        }, { submissionKey: reporter?.providerSubmissionKey });
        if (!isCurrentGenerationRun(runId)) return;
        await reporter?.providerSubmitted({
          provider: traceProvider,
          model: traceModel,
          upstreamTaskId: result.taskId,
          requestId: result.requestId,
          transportHttpStatus: result.transportHttpStatus,
          upstreamHttpStatus: result.upstreamHttpStatus,
          usage: result.usage,
          httpStatusSource: 'local-backend',
        });
        update({ status: 'polling', taskId: result.taskId, lastPrompt: finalPrompt, progress: '0%' });
        logBus.info('Vidu Q3 任务已提交，开始轮询', src);
        await startPolling(result.taskId, runId, reporter);
        return;
      }

      if (isHappyHorse) {
        const happyImages = happyHorseMode === 't2v'
          ? []
          : imageUrls.slice(0, happyHorseMode === 'i2v' ? 1 : 9);
        logBus.info(
          `提交 Happy Horse: ${apiModel} · ${duration}s · ${resolution || '720p'} · ${ratio} · refs=${happyImages.length}`,
          src,
        );
        const result = await submitHappyHorse({
          model: apiModel as 'happyhorse-1.1-t2v' | 'happyhorse-1.1-i2v' | 'happyhorse-1.1-r2v',
          prompt: finalPrompt || undefined,
          duration: Number(duration) || 4,
          ratio,
          resolution: (resolution === '1080p' ? '1080p' : '720p'),
          images: happyImages.length ? happyImages : undefined,
        }, { submissionKey: reporter?.providerSubmissionKey });
        if (!isCurrentGenerationRun(runId)) return;
        await reporter?.providerSubmitted({
          provider: traceProvider,
          model: traceModel,
          upstreamTaskId: result.taskId,
          requestId: result.requestId,
          transportHttpStatus: result.transportHttpStatus,
          upstreamHttpStatus: result.upstreamHttpStatus,
          usage: result.usage,
          httpStatusSource: 'local-backend',
        });
        update({ status: 'polling', taskId: result.taskId, lastPrompt: finalPrompt, progress: '0%' });
        logBus.info(`Happy Horse 任务 ${result.taskId} 已提交，开始轮询`, src);
        await startPolling(result.taskId, runId, reporter);
        return;
      }

      // === FAL 分支 ===
      if (isFal && falReg) {
        const falMaxRefs =
          falReg.paramKind === 'grok-fal' && (isGrokFalV15 || gkfMode !== 'reference_to_video')
            ? 1
            : falReg.maxRefImages;
        const refs = imageUrls.slice(0, falMaxRefs);
        let images: string[] | undefined;
        if (refs.length > 0) {
          // FAL 参考图直传 URL 或 base64，后端会处理上传
          images = refs;
        }

        const falReq: VideoFalSubmitRequest = { apiModel, prompt: finalPrompt, providerParams };
        if (images && images.length) falReq.images = images;

        if (falReg.paramKind === 'veo-fal') {
          falReq.aspect_ratio = vfRatio;
          falReq.duration = vfDuration;
          falReq.resolution = vfResolution;
          falReq.generate_audio = vfAudio;
          falReq.safety_tolerance = vfSafety;
        } else if (falReg.paramKind === 'grok-fal') {
          const effectiveGkfMode = isGrokFalV15 ? 'image_to_video' : gkfMode;
          const pastedReferenceUrls = isGrokFalV15
            ? []
            : splitGrokFalRefUrls(gkfReferenceUrls).slice(0, Math.max(0, 7 - (images?.length || 0)));
          if (isGrokFalV15 && (!images || images.length === 0)) {
            throw new Error('Grok Video 1.5 需要至少 1 张参考图');
          }
          if (!isGrokFalV15 && effectiveGkfMode === 'reference_to_video' && (!images || images.length === 0) && pastedReferenceUrls.length === 0) {
            throw new Error('Grok FAL 参考生视频需要至少 1 张参考图或 URL');
          }
          falReq.gkMode = effectiveGkfMode;
          if (!isGrokFalV15) {
            falReq.gkRatio = effectiveGkfMode === 'reference_to_video' && gkfRatio === 'auto' ? '16:9' : gkfRatio;
          }
          falReq.gkDuration = gkfDuration;
          falReq.resolution = gkfResolution;
          falReq.image_mode = falReg.defaultImageMode || 'base64';
          if (pastedReferenceUrls.length) falReq.gkReferenceUrls = pastedReferenceUrls;
        } else if (falReg.paramKind === 'sora-fal') {
          if (soraMode === 'image_to_video' && (!images || images.length === 0)) {
            throw new Error('Sora2 图生视频需要 1 张参考图');
          }
          falReq.soraMode = soraMode;
          falReq.soraRatio = soraRatio;
          falReq.soraDuration = soraDuration;
          falReq.soraResolution = soraResolution;
          falReq.soraDeleteVideo = soraDeleteVideo;
          falReq.soraBlockIp = soraBlockIp;
          falReq.soraCharacterIds = soraCharacterIds;
          falReq.image_mode = falReg.defaultImageMode || 'base64';
        }

        const falInfo =
          falReg.paramKind === 'veo-fal'
            ? `ratio=${vfRatio} dur=${vfDuration} res=${vfResolution} audio=${vfAudio}`
            : falReg.paramKind === 'grok-fal'
              ? isGrokFalV15
                ? `model=1.5 mode=image_to_video dur=${gkfDuration}s res=${gkfResolution} image=${falReg.defaultImageMode || 'base64'}`
                : `mode=${gkfMode} ratio=${gkfMode === 'reference_to_video' && gkfRatio === 'auto' ? '16:9' : gkfRatio} dur=${gkfDuration}s res=${gkfResolution} image=${falReg.defaultImageMode || 'base64'} urls=${splitGrokFalRefUrls(gkfReferenceUrls).length}`
              : `mode=${soraMode} ratio=${soraRatio} dur=${soraDuration}s res=${soraResolution} image=base64`;
        logBus.info(
          `提交 FAL 视频: ${apiModel} ${falInfo} refs=${images?.length || 0} prompt="${finalPrompt.slice(0, 30)}…"`,
          src,
        );

        const r = await submitVideoFal(falReq, {
          submissionKey: reporter?.providerSubmissionKey,
        });
        if (!isCurrentGenerationRun(runId)) return;
        if (r.sync && r.videoUrl) {
          await reporter?.providerResponse({
            provider: traceProvider,
            model: traceModel,
            requestId: r.requestId,
            transportHttpStatus: r.transportHttpStatus,
            upstreamHttpStatus: r.upstreamHttpStatus,
            usage: r.usage,
            status: 'succeeded',
            httpStatusSource: 'local-backend',
          });
          update({
            status: 'success',
            videoUrl: r.videoUrl,
            lastPrompt: finalPrompt,
            progress: '100%',
            provider: traceProvider,
            apiModel: traceModel,
            requestId: r.requestId,
            transportHttpStatus: r.transportHttpStatus,
            upstreamHttpStatus: r.upstreamHttpStatus,
            usage: r.usage,
          });
          logBus.success(`FAL 同步完成 → ${r.videoUrl}`, src);
          taskCompletionSound.notifyComplete(id, 'video');
        } else {
          falPollRef.current = { endpoint: r.endpoint, requestId: r.requestId };
          await reporter?.providerSubmitted({
            provider: traceProvider,
            model: traceModel,
            requestId: r.requestId,
            transportHttpStatus: r.transportHttpStatus,
            upstreamHttpStatus: r.upstreamHttpStatus,
            usage: r.usage,
            httpStatusSource: 'local-backend',
          });
          update({ status: 'polling', lastPrompt: finalPrompt, progress: '15%' });
          logBus.info(`FAL 异步任务 requestId=${r.requestId} 进入轮询…`, src);
          // v1.2.9.11: await 让 useRunTrigger 等到任务真正完成才 markDone
          await startFalPolling(runId, reporter);
        }
        return;
      }

      // === 原有贞贞工坊分支 ===
      // 参考图预处理:
      //   - Grok: 直接传 URL (本地 /files/* 也可,后端会转上游 URL)
      //   - Veo / Sora2 / Seedance: 转 base64
      const refs = imageUrls.slice(0, (isVeoOmni || isGrok15New) ? 1 : modelDef.maxRefImages);
      let images: string[] | undefined;
      if (modelDef.supportImages && refs.length > 0) {
        if (modelDef.kind === 'grok') {
          images = refs;
        } else {
          const arr: string[] = [];
          for (const u of refs) {
            try {
              const encoded = await urlToBase64(u);
              if (!isCurrentGenerationRun(runId)) return;
              arr.push(encoded);
            }
            catch (e) { console.warn('图像编码失败', e); }
          }
          if (arr.length) images = arr;
        }
      }

      // 按 kind 走不同字段(完全对齐 gpt-image-2-web payload)
      const payload: VideoSubmitRequest = { model: apiModel, prompt: finalPrompt, providerParams };
      if (isGrok15New) {
        payload.size = grok15NewSize;
      } else if (modelDef.kind === 'grok') {
        payload.ratio = ratio;
        payload.duration = Number(duration) || modelDef.defaultDuration || 15;
        payload.resolution = resolution || modelDef.defaultResolution || '720P';
        if (seed > 0) payload.seed = seed;
      } else if (modelDef.kind === 'sora') {
        payload.aspect_ratio = ratio;
        payload.duration = Number(duration) || modelDef.defaultDuration || 15;
        payload.private = soraPrivate;
        if (seed > 0) payload.seed = seed;
      } else {
        // veo / seedance
        payload.aspect_ratio = ratio;
        if (isVeoOmni) {
          payload.duration = 10;
        } else {
          payload.enhance_prompt = enhancePrompt;
          if (enableUpsample) payload.enable_upsample = true;
        }
        if (seed > 0) payload.seed = seed;
      }
      if (images && images.length) payload.images = images;

      logBus.info(
        `提交任务: kind=${modelDef.kind} model=${apiModel} ratio=${ratio}` +
        (isGrok15New
          ? ` size=${payload.size} v1-multipart`
          : modelDef.kind === 'grok'
          ? ` duration=${payload.duration}s resolution=${payload.resolution}`
          : modelDef.kind === 'sora'
            ? ` duration=${payload.duration}s private=${payload.private}`
            : isVeoOmni
              ? ' duration=10s endpoint=/v1/videos'
              : ` enhance=${payload.enhance_prompt}`) +
        ` refs=${images?.length || 0} prompt="${finalPrompt.slice(0, 30)}…"`,
        src,
      );

      const r = await submitVideo(payload, {
        submissionKey: reporter?.providerSubmissionKey,
      });
      if (!isCurrentGenerationRun(runId)) return;
      await reporter?.providerSubmitted({
        provider: traceProvider,
        model: traceModel,
        upstreamTaskId: r.taskId,
        requestId: r.requestId,
        transportHttpStatus: r.transportHttpStatus,
        upstreamHttpStatus: r.upstreamHttpStatus,
        usage: r.usage,
        httpStatusSource: 'local-backend',
      });
      update({ status: 'polling', taskId: r.taskId, lastPrompt: finalPrompt, progress: '0%' });
      logBus.info(`异步任务已提交 taskId=${r.taskId} 进入轮询…`, src);
      // v1.2.9.11: await 让 useRunTrigger 等到任务真正完成才 markDone
      await startPolling(r.taskId, runId, reporter);
    } catch (e: any) {
      if (!isCurrentGenerationRun(runId)) return;
      const msg = normalizeProviderErrorMessage(e, '提交失败');
      await reporter?.providerResponse({
        provider: traceProvider,
        model: traceModel,
        transportHttpStatus: e?.transportHttpStatus,
        upstreamHttpStatus: e?.upstreamHttpStatus,
        requestId: e?.requestId,
        status: 'failed',
        error: { message: msg, code: e?.code },
        httpStatusSource: 'local-backend',
      });
      setError(msg);
      update({ status: 'error', error: msg });
      logBus.error(`提交失败: ${msg}`, src);
    }
  };

  const handleStop = () => {
    generationRunRef.current += 1;
    cancelActivePoll();
    falPollRef.current = null;
    setError(null);
    update({ status: 'idle', progress: '已停止', error: null, taskId: null });
    logBus.warn('用户主动停止：已停止本地轮询，远端任务可能仍会完成', src);
  };

  // 批量运行接入
  useRunTrigger(id, async (reporter) => {
    if (status === 'submitting' || status === 'polling') return;
    await handleGenerate(reporter);
  }, 'video', {
    lifecycleAware: true,
    shouldReuseResult: (nodeData) => shouldReuseGenerationResult('video', nodeData),
  });

  // === 跨节点拖拽: source (输出视频可拖出) ===
  const startDrag = useDragMaterialStore((s) => s.start);
  const beginMaterialDrag = (e: React.MouseEvent, payload: MaterialPayload) => {
    if (e.button !== 0 || !(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    e.stopPropagation();
    startDrag(payload, e.clientX, e.clientY);
  };

  // === 跨节点拖拽: target (接收 image/video/audio/text) ===
  const handleDrop = (payload: MaterialPayload) => {
    if (payload.kind === 'image' && payload.url) {
      const cur = Array.isArray(d?.localRefImages) ? d.localRefImages : [];
      if (cur.indexOf(payload.url) !== -1) return;
      const cap = isWan
        ? 1
        : isKling
        ? maxMentionRefs
        : isVidu
        ? maxMentionRefs
        : isHappyHorse
        ? maxMentionRefs
        : isApimartBudgetVideo
        ? maxMentionRefs
        : isGrok15New
          ? 1
          : isJimengSeedanceSelected
            ? jimengImageLimit
            : (modelDef.maxRefImages || 7) + 4;
      if (cur.length >= cap) return;
      update({ localRefImages: [...cur, payload.url] });
    } else if (payload.kind === 'video' && payload.url && (isJimengSeedanceSelected || isApimartOmni || isUpscaler || (isKling && klingMode === 'edit'))) {
      const cur = Array.isArray(d?.localRefVideos) ? d.localRefVideos : [];
      const cap = isUpscaler || isApimartOmni || (isKling && klingMode === 'edit') ? 1 : JIMENG_SEEDANCE_LIMITS.videos;
      if (cur.indexOf(payload.url) !== -1 || cur.length >= cap) return;
      update({ localRefVideos: [...cur, payload.url] });
    } else if (payload.kind === 'audio' && payload.url && isJimengSeedanceSelected) {
      const cur = Array.isArray(d?.localRefAudios) ? d.localRefAudios : [];
      if (cur.indexOf(payload.url) !== -1 || cur.length >= JIMENG_SEEDANCE_LIMITS.audios) return;
      update({ localRefAudios: [...cur, payload.url] });
    } else if (payload.kind === 'text' && typeof payload.text === 'string') {
      update({ prompt: payload.text });
    }
  };
  const { dropProps, isAccepting } = useMaterialDropTarget({
    id,
    accepts: isJimengSeedanceSelected
      ? ['image', 'video', 'audio', 'text']
      : isApimartOmni ? ['image', 'video', 'text']
      : isApimartV31Lite ? ['text']
      : isUpscaler ? ['video']
      : isKling && klingMode === 'edit' ? ['video', 'text'] : ['image', 'text'],
    onDrop: handleDrop,
  });

  const isBusy = status === 'submitting' || status === 'polling';
  const refsCount = orderedImages.length + localRefImages.length;
  const videoRefsCount = orderedVideos.length + localRefVideos.length;
  const audioRefsCount = orderedAudios.length + localRefAudios.length;
  const previewTitle = isWan
    ? `上游素材 · 首帧图 ${Math.min(refsCount, 1)}/1`
    : isUpscaler
    ? `上游素材 · 输入 MP4 ${Math.min(videoRefsCount, 1)}/1`
    : isKling
    ? klingMode === 't2v'
      ? '上游素材 · 当前模型不使用参考素材'
      : klingMode === 'edit'
        ? `上游素材 · 输入视频 ${Math.min(videoRefsCount, 1)}/1`
        : `上游素材 · ${klingMode === 'i2v' ? '首尾帧' : '参考图'} ${Math.min(refsCount, maxMentionRefs)}/${maxMentionRefs}`
    : isVidu
    ? viduMode === 't2v'
      ? '上游素材 · 当前模型不使用参考图'
      : `上游素材 · ${viduMode === 'short-play' ? '资产图' : '参考图'} ${Math.min(refsCount, maxMentionRefs)}/${maxMentionRefs}`
    : isHappyHorse
    ? happyHorseMode === 't2v'
      ? '上游素材 · 当前模型不使用参考图'
      : `上游素材 · 参考图 ${Math.min(refsCount, maxMentionRefs)}/${maxMentionRefs}`
    : isApimartOmni
    ? `上游素材 · 图片 ${Math.min(refsCount, 16)}/16 · 视频 ${Math.min(videoRefsCount, 1)}/1`
    : isApimartBudgetVideo
    ? `上游素材 · 参考图 ${Math.min(refsCount, maxMentionRefs)}/${maxMentionRefs}`
    : isJimengSeedanceSelected
    ? `上游素材 · 图${Math.min(refsCount, jimengImageLimit)}/${jimengImageLimit} 视${Math.min(videoRefsCount, JIMENG_SEEDANCE_LIMITS.videos)}/${JIMENG_SEEDANCE_LIMITS.videos} 音${Math.min(audioRefsCount, JIMENG_SEEDANCE_LIMITS.audios)}/${JIMENG_SEEDANCE_LIMITS.audios}`
    : `上游素材 · 参考图 ${Math.min(refsCount, maxMentionRefs)}/${maxMentionRefs}`;

  return (
    <div
      {...dropProps}
      className={`relative rounded-xl border-2 transition-all w-[300px] ${
        selected ? 'border-rose-400 shadow-2xl shadow-rose-500/20' : isAccepting ? 'border-emerald-400' : 'border-white/15 hover:border-white/30'
      }`}
      style={{
        background: 'rgba(20,20,22,.92)',
        backdropFilter: 'blur(8px)',
        boxShadow: isAccepting ? '0 0 0 2px rgba(52,211,153,.45), 0 12px 30px rgba(52,211,153,.18)' : undefined,
      }}
    >
      <Handle type="target" position={Position.Left} className="!bg-rose-400 !border-0" />
      <Handle type="source" position={Position.Right} className="!bg-rose-400 !border-0" />

      <div className="flex items-center gap-2 px-3 py-2 border-b border-white/10">
        <div
          className="w-6 h-6 rounded flex items-center justify-center"
          style={{ background: 'rgba(244,63,94,.2)', color: '#fda4af', boxShadow: 'inset 0 0 0 1px rgba(244,63,94,.45)' }}
        >
          <VideoIcon size={13} />
        </div>
        <div className="flex-1">
          <div className="text-sm font-semibold text-white">视频</div>
          <div className="text-[10px] text-white/40">
            {isExternalSelected && providerSelection.provider
              ? `${providerSelection.provider.label || providerSelection.provider.id} · ${externalProviderModel || '未选模型'}`
              : isSeedanceNzVideo
                ? `贞贞的平价AI小屋 · ${apiModel}`
              : `${modelDef.label} · ${modelDef.kind}`}
          </div>
        </div>
        {isJimengCliSelected && <JimengCliHelpButton />}
      </div>

      <div className="p-2.5 space-y-2" onMouseDown={(e) => e.stopPropagation()}>
        <div className="rounded border border-white/10 bg-white/[0.03] p-2 space-y-2">
            <button
              type="button"
              onClick={() => update({ advancedProviderOpen: !d?.advancedProviderOpen })}
              className="w-full flex items-center justify-between text-[10px] font-semibold text-white/70 hover:text-white"
            >
              <span>高级来源</span>
              <span>
                {isExternalSelected && providerSelection.provider
                  ? providerSelection.provider.label
                  : videoBuiltinSource === 'seedance-nz'
                    ? '贞贞的平价AI小屋'
                    : '贞贞的AI工坊'}
              </span>
            </button>
            {d?.advancedProviderOpen && (
              <div className="space-y-2">
                <div>
                  <label className="text-[10px] text-white/50 block mb-1">平台</label>
                  <select
                    value={isExternalSelected
                      ? providerSelection.providerId
                      : videoBuiltinSource === 'seedance-nz'
                        ? 'builtin:seedance-nz'
                        : 'zhenzhen'}
                    onChange={(e) => {
                      const nextId = e.target.value;
                      if (nextId === 'zhenzhen') {
                        switchBuiltinVideoSource('zhenzhen');
                        return;
                      }
                      if (nextId === 'builtin:seedance-nz') {
                        switchBuiltinVideoSource('seedance-nz');
                        return;
                      }
                      const provider = videoAdvancedProviders.find((item) => item.id === nextId);
                      if (!provider) return;
                      const nextModels = advancedProviderModelOptions(provider, 'video');
                      update({
                        providerSource: provider.protocol,
                        providerId: provider.id,
                        providerModel: nextModels[0] || '',
                        ...(provider.protocol === 'jimeng-cli' ? { resolution: '720p' } : {}),
                        ...(provider.protocol === 'agnes'
                          ? {
                            ratio: '16:9',
                            duration: 5,
                            resolution: '720p',
                            providerParams: { ...providerParams, frameRate: 24 },
                          }
                          : {}),
                      });
                    }}
                    style={{ background: '#18181b', color: '#ffffff' }}
                    className="w-full rounded border border-white/10 px-2 py-1 text-xs outline-none focus:border-white/30"
                  >
                    <option value="zhenzhen" style={{ background: '#18181b', color: '#ffffff' }}>贞贞的AI工坊（默认）</option>
                    <option value="builtin:seedance-nz" style={{ background: '#18181b', color: '#ffffff' }}>贞贞的平价AI小屋</option>
                    {videoAdvancedProviders.map((provider) => (
                      <option key={provider.id} value={provider.id} style={{ background: '#18181b', color: '#ffffff' }}>
                        {provider.label || provider.id}
                      </option>
                    ))}
                  </select>
                </div>
                {isExternalSelected && providerSelection.provider && (
                  <div>
                    <label className="text-[10px] text-white/50 block mb-1">外部模型</label>
                    <select
                      value={externalProviderModel}
                      onChange={(e) => {
                        const nextModel = e.target.value;
                        update({
                          providerModel: nextModel,
                          ...(providerSelection.provider?.protocol === 'jimeng-cli'
                            && nextModel !== 'seedance2.0_vip'
                            ? { resolution: '720p' }
                            : {}),
                        });
                      }}
                      style={{ background: '#18181b', color: '#ffffff' }}
                      className="w-full rounded border border-white/10 px-2 py-1 text-xs outline-none focus:border-white/30"
                    >
                      {externalModelOptions.map((m) => (
                        <option key={m} value={m} style={{ background: '#18181b', color: '#ffffff' }}>{m}</option>
                      ))}
                    </select>
                  </div>
                )}
                {savedExternalMissing && (
                  <div className="text-[10px] text-amber-200 bg-amber-500/10 border border-amber-500/20 rounded px-2 py-1">
                    当前画布记录的扩展平台未启用或不存在，已临时回到默认来源。
                  </div>
                )}
              </div>
            )}
        </div>

        {/* 主模型 */}
        {!isExternalSelected && (
        <div>
          <label className="text-[10px] text-white/50 block mb-1">模型类型</label>
          <select
            value={modelDef.id}
            onChange={(e) => switchMainModel(e.target.value)}
            className="w-full rounded bg-white/5 border border-white/10 px-2 py-1 text-xs text-white outline-none focus:border-white/30"
          >
            {builtinVideoModels.map((m) => (
              <option key={m.id} value={m.id} className="bg-zinc-900">{m.label}</option>
            ))}
          </select>
        </div>
        )}

        {/* 子模型(主项目 veo_model / gk_model) */}
        {!isExternalSelected && builtinApiModelOptions.length > 1 && (
          <div>
            <label className="text-[10px] text-white/50 block mb-1">具体模型</label>
            <select
              value={apiModel}
              onChange={(e) => {
                const nextModel = e.target.value;
                update({
                  model: nextModel,
                  ...(nextModel === 'grok-imagine-video-1.5' ? { gkfMode: 'image_to_video' } : {}),
                  ...(isGrokVideo15NewModel(nextModel) ? { ratio: '16:9', size: '1280x720', resolution: '' } : {}),
                   ...(nextModel === 'sora-2-zhenzhen' ? { ratio: '16:9', duration: 15, resolution: '' } : {}),
                   ...(nextModel === 'veo-omni-10s' ? { ratio: '16:9', duration: 10, resolution: '' } : {}),
                   ...(nextModel === ZHENZHEN_VIDEO_G_OMNI_FLASH_MODEL
                     ? { ratio: '16:9', duration: 0, resolution: '720p' }
                     : {}),
                   ...(nextModel === ZHENZHEN_VIDEO_GK_V15_MODEL
                     ? { ratio: '16:9', duration: 6, resolution: '720p' }
                     : {}),
                   ...(nextModel === ZHENZHEN_VIDEO_V31_FAST_MODEL
                     || nextModel === ZHENZHEN_VIDEO_V31_QUALITY_MODEL
                     || nextModel === ZHENZHEN_VIDEO_V31_LITE_MODEL
                     ? { ratio: '16:9', duration: 8, resolution: '720p' }
                     : {}),
                   ...(nextModel.endsWith('-short-play')
                     ? { ratio: '9:16', duration: 8, resolution: '1080p' }
                     : nextModel.startsWith('vidu-q3-')
                       ? { ratio: '16:9', duration: 4, resolution: 'default' }
                       : {}),
                 });
              }}
              className="w-full rounded bg-white/5 border border-white/10 px-2 py-1 text-xs text-white outline-none focus:border-white/30"
            >
              {builtinApiModelOptions.map((o) => (
                <option key={o.value} value={o.value} disabled={o.disabled} className="bg-zinc-900">{o.label}</option>
              ))}
            </select>
          </div>
        )}

        <LocalNodeAddonSlot
          nodeId={id}
          nodeType="video"
          data={d}
          update={update}
          context={{
            providerSource: isExternalSelected ? providerSelection.providerSource : (isSeedanceNzVideo ? 'seedance-nz' : 'zhenzhen'),
            providerId: providerSelection.providerId,
            providerModel: isExternalSelected ? externalProviderModel : apiModel,
            model: apiModel,
            apiModel,
            mainId,
            providerKind: isFal ? 'fal' : (isSeedanceNzVideo ? 'seedance-nz-video' : modelDef.kind),
          }}
        />

        {/* === FAL 专属参数面板 === */}
        {showBuiltinFalControls && falReg?.paramKind === 'veo-fal' && (
          <>
            <div className="grid grid-cols-2 gap-1.5">
              <div>
                <label className="text-[10px] text-white/50 block mb-1">比例 (FAL)</label>
                <select value={vfRatio} onChange={(e) => update({ vfRatio: e.target.value })} className="w-full rounded bg-white/5 border border-white/10 px-2 py-1 text-xs text-white outline-none focus:border-white/30">
                  {VEO_FAL_RATIOS.map((r) => <option key={r} value={r} className="bg-zinc-900">{r}</option>)}
                </select>
              </div>
              <div>
                <label className="text-[10px] text-white/50 block mb-1">时长</label>
                <select value={vfDuration} onChange={(e) => update({ vfDuration: e.target.value })} className="w-full rounded bg-white/5 border border-white/10 px-2 py-1 text-xs text-white outline-none focus:border-white/30">
                  {VEO_FAL_DURATIONS.map((d) => <option key={d} value={d} className="bg-zinc-900">{d}</option>)}
                </select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              <div>
                <label className="text-[10px] text-white/50 block mb-1">分辨率</label>
                <select value={vfResolution} onChange={(e) => update({ vfResolution: e.target.value })} className="w-full rounded bg-white/5 border border-white/10 px-2 py-1 text-xs text-white outline-none focus:border-white/30">
                  {VEO_FAL_RESOLUTIONS.map((r) => <option key={r} value={r} className="bg-zinc-900">{r}</option>)}
                </select>
              </div>
              <div>
                <label className="text-[10px] text-white/50 block mb-1">安全等级</label>
                <select value={String(vfSafety)} onChange={(e) => update({ vfSafety: Number(e.target.value) })} className="w-full rounded bg-white/5 border border-white/10 px-2 py-1 text-xs text-white outline-none focus:border-white/30">
                  {[1,2,3,4,5,6].map((s) => <option key={s} value={s} className="bg-zinc-900">{s}</option>)}
                </select>
              </div>
            </div>
            <label className="flex items-center gap-1 text-[10px] text-white/60 cursor-pointer">
              <input type="checkbox" checked={vfAudio} onChange={(e) => update({ vfAudio: e.target.checked })} className="accent-rose-400" />
              生成音频
            </label>
          </>
        )}

        {showBuiltinFalControls && falReg?.paramKind === 'grok-fal' && (
          <>
            {isGrokFalV15 ? (
              <div className="rounded border border-white/10 bg-white/5 px-2 py-1.5 text-[10px] leading-relaxed text-white/60">
                Grok Video 1.5 仅支持图生视频，必须有 1 张参考图；图像传入模式默认 Base64，不发送比例参数。
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-1.5">
                <div>
                  <label className="text-[10px] text-white/50 block mb-1">模式 (FAL)</label>
                  <select
                    value={gkfMode}
                    onChange={(e) => {
                      const next = e.target.value as 'image_to_video' | 'reference_to_video';
                      update({
                        gkfMode: next,
                        ...(next === 'reference_to_video' && gkfRatio === 'auto' ? { gkfRatio: '16:9' } : {}),
                      });
                    }}
                    className="w-full rounded bg-white/5 border border-white/10 px-2 py-1 text-xs text-white outline-none focus:border-white/30"
                  >
                    {GROK_FAL_MODES.map((m) => <option key={m.value} value={m.value} className="bg-zinc-900">{m.label}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-[10px] text-white/50 block mb-1">比例 (FAL)</label>
                  <select value={gkfRatio} onChange={(e) => update({ gkfRatio: e.target.value })} className="w-full rounded bg-white/5 border border-white/10 px-2 py-1 text-xs text-white outline-none focus:border-white/30">
                    {GROK_FAL_RATIOS.map((r) => <option key={r} value={r} className="bg-zinc-900">{r}</option>)}
                  </select>
                </div>
              </div>
            )}
            <div className="grid grid-cols-2 gap-1.5">
              <div>
                <label className="text-[10px] text-white/50 block mb-1">时长(s)</label>
                <input type="number" value={gkfDuration} min={1} max={30} onChange={(e) => update({ gkfDuration: Number(e.target.value) || 6 })} className="w-full rounded bg-white/5 border border-white/10 px-2 py-1 text-xs text-white outline-none focus:border-white/30" />
              </div>
              <div>
                <label className="text-[10px] text-white/50 block mb-1">分辨率</label>
                <select value={gkfResolution} onChange={(e) => update({ gkfResolution: e.target.value })} className="w-full rounded bg-white/5 border border-white/10 px-2 py-1 text-xs text-white outline-none focus:border-white/30">
                  {GROK_FAL_RESOLUTIONS.map((r) => <option key={r} value={r} className="bg-zinc-900">{r}</option>)}
                </select>
              </div>
            </div>
            {!isGrokFalV15 && gkfMode === 'reference_to_video' && (
              <div>
                <label className="text-[10px] text-white/50 block mb-1">公开参考 URL(可选)</label>
                <textarea
                  value={gkfReferenceUrls}
                  onChange={(e) => update({ gkfReferenceUrls: e.target.value })}
                  placeholder="每行或逗号分隔，最多补足到 7 张"
                  className="w-full h-12 resize-none rounded bg-white/5 border border-white/10 px-2 py-1 text-xs text-white outline-none focus:border-white/30"
                />
              </div>
            )}
            <div className="text-[10px] text-white/45 leading-relaxed">
              {isGrokFalV15
                ? '只取第 1 张参考图，提交到 v1.5 image-to-video；Base64 为默认传入方式。'
                : gkfMode === 'reference_to_video'
                ? '参考生视频最多 7 张，优先使用上游/本地图，再补充 URL。'
                : '图生视频只取第 1 张参考图；无图时保留文生视频 fallback。'}
            </div>
          </>
        )}

        {showBuiltinFalControls && falReg?.paramKind === 'sora-fal' && (
          <>
            <div className="grid grid-cols-2 gap-1.5">
              <div>
                <label className="text-[10px] text-white/50 block mb-1">FAL Mode</label>
                <select value={soraMode} onChange={(e) => update({ soraMode: e.target.value })} className="w-full rounded bg-white/5 border border-white/10 px-2 py-1 text-xs text-white outline-none focus:border-white/30">
                  {SORA2_FAL_MODES.map((m) => <option key={m.value} value={m.value} className="bg-zinc-900">{m.label}</option>)}
                </select>
              </div>
              <div>
                <label className="text-[10px] text-white/50 block mb-1">比例</label>
                <select value={soraRatio} onChange={(e) => update({ soraRatio: e.target.value })} className="w-full rounded bg-white/5 border border-white/10 px-2 py-1 text-xs text-white outline-none focus:border-white/30">
                  {SORA2_FAL_RATIOS.map((r) => <option key={r} value={r} className="bg-zinc-900">{r}</option>)}
                </select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              <div>
                <label className="text-[10px] text-white/50 block mb-1">时长</label>
                <select value={String(soraDuration)} onChange={(e) => update({ soraDuration: Number(e.target.value) || 4 })} className="w-full rounded bg-white/5 border border-white/10 px-2 py-1 text-xs text-white outline-none focus:border-white/30">
                  {SORA2_FAL_DURATIONS.map((d) => <option key={d} value={d} className="bg-zinc-900">{d}s</option>)}
                </select>
              </div>
              <div>
                <label className="text-[10px] text-white/50 block mb-1">分辨率</label>
                <select value={soraResolution} onChange={(e) => update({ soraResolution: e.target.value })} className="w-full rounded bg-white/5 border border-white/10 px-2 py-1 text-xs text-white outline-none focus:border-white/30">
                  {SORA2_FAL_RESOLUTIONS.map((r) => <option key={r} value={r} className="bg-zinc-900">{r}</option>)}
                </select>
              </div>
            </div>
            <div>
              <label className="text-[10px] text-white/50 block mb-1">Character IDs</label>
              <input
                value={soraCharacterIds}
                onChange={(e) => update({ soraCharacterIds: e.target.value })}
                placeholder="id1, id2"
                className="w-full rounded bg-white/5 border border-white/10 px-2 py-1 text-xs text-white outline-none focus:border-white/30 placeholder:text-white/25"
              />
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              <label className="flex items-center gap-1 text-[10px] text-white/60 cursor-pointer">
                <input type="checkbox" checked={soraDeleteVideo} onChange={(e) => update({ soraDeleteVideo: e.target.checked })} className="accent-rose-400" />
                Delete Video
              </label>
              <label className="flex items-center gap-1 text-[10px] text-white/60 cursor-pointer">
                <input type="checkbox" checked={soraBlockIp} onChange={(e) => update({ soraBlockIp: e.target.checked })} className="accent-rose-400" />
                Block IP
              </label>
            </div>
            <div className="rounded border border-white/10 bg-white/5 px-2 py-1 text-[10px] leading-relaxed text-white/45">
              默认用 Base64 传入第 1 张参考图；Auto 无图时走文生视频。
            </div>
          </>
        )}

        {isSoraZhenzhen && (
          <div className="rounded border border-white/10 bg-white/5 px-2 py-1.5 space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10px] font-semibold text-white/70">Sora2 Zhenzhen API</span>
              <span className="text-[9px] text-white/35">参考图 ≤ 1</span>
            </div>
            <label className="flex items-center gap-1.5 text-[10px] text-white/60 cursor-pointer">
              <input
                type="checkbox"
                checked={soraPrivate}
                onChange={(e) => update({ soraPrivate: e.target.checked })}
                className="accent-rose-400"
              />
              Private
            </label>
            <div className="text-[10px] text-white/40 leading-relaxed">
              提交到 /v2/videos/generations，真实模型名为 sora-2；参考图会转为裸 Base64。
            </div>
          </div>
        )}

        {isVeoOmni && (
          <div className="rounded border border-white/10 bg-white/5 px-2 py-1.5 text-[10px] leading-relaxed text-white/45">
            Veo Omni 走 /v1/videos，固定调用 omni_flash-10s，需要 1 张参考图；16:9=1280x720，9:16=720x1280。
          </div>
        )}

        {isGrok15New && (
          <>
            <div>
              <label className="text-[10px] text-white/50 block mb-1">尺寸</label>
              <select
                value={grok15NewSize}
                onChange={(e) => {
                  const nextSize = e.target.value;
                  update({
                    size: nextSize,
                    ratio: nextSize === '720x1280' ? '9:16' : '16:9',
                  });
                }}
                className="w-full rounded bg-white/5 border border-white/10 px-2 py-1 text-xs text-white outline-none focus:border-white/30"
              >
                {GROK_VIDEO_1_5_NEW_SIZES.map((item) => (
                  <option key={item.value} value={item.value} className="bg-zinc-900">{item.label}</option>
                ))}
              </select>
            </div>
            <div className="rounded border border-white/10 bg-white/5 px-2 py-1.5 text-[10px] leading-relaxed text-white/45">
              Grok 1.5 New 需要 1 张参考图；按 Comfly 原节点提交 model / prompt / size / input_reference，时长由具体模型 6s / 10s / 15s 决定。
            </div>
          </>
        )}

        {isHappyHorse && (
          <div className="rounded border border-amber-300/20 bg-amber-400/[0.06] px-2 py-1.5 text-[10px] leading-relaxed text-white/55">
            {happyHorseMode === 't2v'
              ? '文生视频只使用提示词，不发送画布中的参考图。'
              : happyHorseMode === 'i2v'
                ? '图生视频必须有参考图，只取排序后的第 1 张作为首图。'
                : '参考图生视频需要 1-9 张图，可在提示词中使用“图1 / 图2”指代。'}
            <div className="mt-1 text-white/35">贞贞的平价AI小屋 · 3-15 秒 · 720p / 1080p</div>
          </div>
        )}

        {isApimartBudgetVideo && (
          <div className="rounded border border-cyan-300/20 bg-cyan-400/[0.06] px-2 py-1.5 text-[10px] leading-relaxed text-white/55">
            <div>贞贞的平价AI小屋 · {apiModel}</div>
            <div className="mt-1 text-white/40">
              {isApimartOmni
                ? 'Omni Flash：时长由模型决定，固定 720p；支持 Prompt、最多 16 张图片，或 1 个参考视频。'
                : isApimartGrok
                  ? 'Grok Video 1.5：6–30 秒，480p / 720p，最多 7 张参考图。'
                  : isApimartV31Fast
                    ? 'Veo 3.1 Fast：固定 8 秒，720p / 1080p / 4K，最多 3 张参考图。'
                    : isApimartV31Quality
                      ? 'Veo 3.1 Quality：固定 8 秒，720p / 1080p / 4K；最多 2 张参考图，避免进入不支持的 3 图 reference 模式。'
                      : 'Veo 3.1 Lite：纯文生视频，固定 8 秒，支持 720p / 1080p / 4K，不接受参考图或参考视频。'}
            </div>
          </div>
        )}

        {isHailuo && (
          <div className="rounded border border-cyan-300/20 bg-cyan-400/[0.06] px-2 py-1.5 text-[10px] leading-relaxed text-white/55">
            {hailuoMode === 't2v'
              ? '文生视频必须填写提示词，不发送画布中的参考图；比例会随请求提交。'
              : '图生视频使用排序后的第 1 张首帧图，提示词可选；比例跟随输入图片，不发送比例参数。'}
            <div className="mt-1 text-white/35">
              贞贞的平价AI小屋 API · 按次计费 · 6 / 10 秒 · 768p / 1080p（1080p 仅 6 秒）
            </div>
            {hailuoMode === 'i2v' && (
              <div className="mt-1 text-white/35">首帧图短边需大于 300px，宽高比需在 2:5 到 5:2 之间。</div>
            )}
          </div>
        )}

        {isKling && (
          <div className="rounded border border-sky-300/20 bg-sky-400/[0.06] px-2 py-1.5 text-[10px] leading-relaxed text-white/55">
            {klingMode === 't2v'
              ? '文生视频必须填写提示词，不发送参考图。'
              : klingMode === 'i2v'
                ? '图生视频使用第 1 张图作为首帧，可选第 2 张图作为尾帧；提示词可选。'
                : klingMode === 'r2v'
                  ? 'O3 参考生视频必须填写提示词，按素材顺序使用 1-4 张参考图。'
                  : 'O3 视频编辑必须填写提示词，并使用第 1 个输入视频。'}
            <div className="mt-1 text-white/35">贞贞的平价AI小屋 API · 按次计费 · 5 / 10 秒</div>
          </div>
        )}

        {isUpscaler && (
          <div className="rounded border border-emerald-300/20 bg-emerald-400/[0.06] px-2 py-1.5 text-[10px] leading-relaxed text-white/55">
            连接或拖入恰好 1 个 MP4 视频，选择目标分辨率后执行高清化；无需 Prompt，时长由输入视频读取。
            <div className="mt-1 text-white/35">贞贞的平价AI小屋 API · 目标 720p / 1080p / 2k / 4k · 输入最长约 10 分钟</div>
          </div>
        )}

        {isVidu && (
          <div className="rounded border border-violet-300/20 bg-violet-400/[0.06] px-2 py-1.5 text-[10px] leading-relaxed text-white/55">
            {viduMode === 't2v'
              ? '文生视频只提交提示词，不发送参考图。'
              : viduMode === 'i2v'
                ? '图生视频使用排序后的第 1 张图作为首帧，提示词可选。'
                : viduMode === 'start-end'
                  ? '首尾帧视频依次使用前 2 张图片作为起始帧和结束帧。'
                  : viduMode === 'r2v'
                    ? '参考生视频使用 1-9 张图片，按画布素材顺序提交。'
                    : '短剧成片把 Prompt 作为脚本内容，并使用 1-14 张图片构造参考资产。'}
            <div className="mt-1 text-white/35">
              贞贞的平价AI小屋 API · 按次计费 · {viduMode === 'short-play' ? '8-12 秒 · 固定 1080p' : '4-15 秒 · default / 720p / 1080p'}
            </div>
          </div>
        )}

        {isWan && (
          <div className="rounded border border-orange-300/20 bg-orange-400/[0.06] p-2 space-y-2">
            <div className="text-[10px] leading-relaxed text-white/60">
              Wan 2.7 Spicy 仅支持图生视频，必须提供 1 张首帧图；提示词可选。
              <div className="mt-1 text-white/35">贞贞的平价AI小屋 · 海外模型 · 2-15 秒 · 720p / 1080p</div>
            </div>
            <div>
              <label className="text-[10px] text-white/50 block mb-1">反向提示词（可选）</label>
              <textarea
                value={wanNegativePrompt}
                onChange={(e) => update({ wanNegativePrompt: e.target.value })}
                placeholder="不希望出现在视频中的内容"
                className="w-full h-12 resize-none rounded bg-white/5 border border-white/10 px-2 py-1 text-[11px] text-white outline-none focus:border-orange-300/40 placeholder:text-white/25"
              />
            </div>
            <div>
              <label className="text-[10px] text-white/50 block mb-1">配乐公网 URL（可选）</label>
              <input
                value={wanAudioUrl}
                onChange={(e) => update({ wanAudioUrl: e.target.value })}
                placeholder="https://.../audio.mp3"
                className="w-full rounded bg-white/5 border border-white/10 px-2 py-1 text-xs text-white outline-none focus:border-orange-300/40 placeholder:text-white/25"
              />
            </div>
            <div className="grid grid-cols-[1fr_110px] gap-2 items-end">
              <label className="flex items-center gap-1.5 text-[10px] text-white/60 cursor-pointer pb-1.5">
                <input
                  type="checkbox"
                  checked={wanPromptExtend}
                  onChange={(e) => update({ wanPromptExtend: e.target.checked })}
                  className="accent-orange-400"
                />
                扩写提示词
              </label>
              <div>
                <label className="text-[10px] text-white/50 block mb-1">Seed（-1 随机）</label>
                <input
                  type="number"
                  min={-1}
                  max={2147483647}
                  value={wanSeed}
                  onChange={(e) => update({ wanSeed: Math.max(-1, Math.min(2147483647, Number(e.target.value) || 0)) })}
                  className="w-full rounded bg-white/5 border border-white/10 px-2 py-1 text-xs text-white outline-none focus:border-orange-300/40"
                />
              </div>
            </div>
          </div>
        )}

        {isJimengSeedanceSelected && (
          <div className="rounded border border-white/10 bg-white/5 p-1.5 space-y-1">
            <div className="rounded border border-lime-300/15 bg-lime-400/[0.05] px-2 py-1 text-[10px] leading-relaxed text-lime-100/70">
              当前按即梦 CLI v1.4.14 适配，视频分辨率为必填参数。
            </div>
            <div className="flex items-center justify-between gap-2">
              <label className="text-[10px] text-white/50">即梦模式</label>
              <span className="text-[9px] text-white/35">
                {jimengSeedanceMode === 'multiframe' ? '多帧图20' : '图9 / 视3 / 音3'}
              </span>
            </div>
            <select
              value={jimengSeedanceMode}
              onChange={(e) => {
                const nextMode = e.target.value;
                update({
                  providerParams: { ...providerParams, frameMode: nextMode },
                  ...(nextMode === 'multiframe' && !['720p', '1080p'].includes(resolution)
                    ? { resolution: '720p' }
                    : {}),
                });
              }}
              className="w-full rounded bg-white/5 border border-white/10 px-2 py-1 text-xs text-white outline-none focus:border-white/30"
            >
              {JIMENG_SEEDANCE_MODE_OPTIONS.map((item) => (
                <option key={item.value} value={item.value} className="bg-zinc-900">{item.label}</option>
              ))}
            </select>
            <div className="text-[10px] text-white/40 leading-relaxed">
              {jimengSeedanceMode === 'omni'
                ? '全能参考支持图片、视频和音频混合输入；纯多图也会走全能参考。'
                : jimengSeedanceMode === 'first'
                  ? '只取第 1 张图作为首帧。'
                  : jimengSeedanceMode === 'firstlast'
                    ? '取第 1 张为首帧，第 2 张为尾帧。'
                    : '仅使用 2-20 张图片序列生成智能多帧；v1.4.14 必须选择 720P 或 1080P。'}
            </div>
          </div>
        )}

        {/* 比例(非 FAL 时显示原始控件) */}
        {showGenericVideoControls && !isGrok15New && !isWan && !isHailuo && !isKling && !isUpscaler && !isVidu && (
        <div className="grid grid-cols-2 gap-1.5">
          <div>
            <label className="text-[10px] text-white/50 block mb-1">比例</label>
            <select
              value={ratio}
              onChange={(e) => update({ ratio: e.target.value })}
              className="w-full rounded bg-white/5 border border-white/10 px-2 py-1 text-xs text-white outline-none focus:border-white/30"
            >
              {ratioOptions.map((r) => (
                <option key={r} value={r} className="bg-zinc-900">{r}</option>
              ))}
            </select>
          </div>
          {/* 时长(grok / seedance) */}
          {durationOptions.length > 0 && (
            <div>
              <label className="text-[10px] text-white/50 block mb-1">时长(s)</label>
              <select
                value={String(duration)}
                onChange={(e) => update({ duration: Number(e.target.value) })}
              className="w-full rounded bg-white/5 border border-white/10 px-2 py-1 text-xs text-white outline-none focus:border-white/30"
            >
                {durationOptions.map((s) => (
                  <option key={s} value={s} className="bg-zinc-900">{s}s</option>
                ))}
              </select>
            </div>
          )}
        </div>
        )}

        {isHailuo && (
          <>
            <div className="grid grid-cols-2 gap-1.5">
              {hailuoMode === 't2v' && (
                <div>
                  <label className="text-[10px] text-white/50 block mb-1">比例</label>
                  <select
                    value={ratio}
                    onChange={(e) => update({ ratio: e.target.value })}
                    className="w-full rounded bg-white/5 border border-white/10 px-2 py-1 text-xs text-white outline-none focus:border-cyan-300/40"
                  >
                    {ratioOptions.map((item) => (
                      <option key={item} value={item} className="bg-zinc-900">{item}</option>
                    ))}
                  </select>
                </div>
              )}
              <div>
                <label className="text-[10px] text-white/50 block mb-1">时长(s)</label>
                <select
                  value={String(hailuoDuration)}
                  onChange={(e) => {
                    const nextDuration = Number(e.target.value) === 10 ? 10 : 6;
                    update({
                      duration: nextDuration,
                      ...(nextDuration === 10 && resolution === '1080p' ? { resolution: '768p' } : {}),
                    });
                  }}
                  className="w-full rounded bg-white/5 border border-white/10 px-2 py-1 text-xs text-white outline-none focus:border-cyan-300/40"
                >
                  {durationOptions.map((seconds) => (
                    <option key={seconds} value={seconds} className="bg-zinc-900">{seconds}s</option>
                  ))}
                </select>
              </div>
            </div>
            <div>
              <label className="text-[10px] text-white/50 block mb-1">分辨率</label>
              <select
                value={resolution === '1080p' ? '1080p' : '768p'}
                onChange={(e) => {
                  const nextResolution = e.target.value === '1080p' ? '1080p' : '768p';
                  update({ resolution: nextResolution, ...(nextResolution === '1080p' ? { duration: 6 } : {}) });
                }}
                className="w-full rounded bg-white/5 border border-white/10 px-2 py-1 text-xs text-white outline-none focus:border-cyan-300/40"
              >
                {resolutionOptions.map((item) => (
                  <option key={item} value={item} className="bg-zinc-900">{item}</option>
                ))}
              </select>
            </div>
          </>
        )}

        {isKling && (
          <div className="rounded border border-sky-300/20 bg-sky-400/[0.06] p-2 space-y-2">
            <div className={klingMode === 'edit' ? '' : 'grid grid-cols-2 gap-1.5'}>
              {klingMode !== 'edit' && (
                <div>
                  <label className="text-[10px] text-white/50 block mb-1">比例</label>
                  <select
                    value={ratio}
                    onChange={(e) => update({ ratio: e.target.value })}
                    className="w-full rounded bg-white/5 border border-white/10 px-2 py-1 text-xs text-white outline-none focus:border-sky-300/40"
                  >
                    {ratioOptions.map((item) => (
                      <option key={item} value={item} className="bg-zinc-900">{item}</option>
                    ))}
                  </select>
                </div>
              )}
              <div>
                <label className="text-[10px] text-white/50 block mb-1">时长(s)</label>
                <select
                  value={String(klingDuration)}
                  onChange={(e) => update({ duration: Number(e.target.value) })}
                  className="w-full rounded bg-white/5 border border-white/10 px-2 py-1 text-xs text-white outline-none focus:border-sky-300/40"
                >
                  {[5, 10].map((item) => (
                    <option key={item} value={item} className="bg-zinc-900">{item}s</option>
                  ))}
                </select>
              </div>
            </div>
            {klingMode !== 'edit' && (
              <div>
                <label className="text-[10px] text-white/50 block mb-1">反向提示词（可选）</label>
                <textarea
                  value={klingNegativePrompt}
                  maxLength={20480}
                  onChange={(e) => update({ klingNegativePrompt: e.target.value })}
                  placeholder="不希望出现在视频中的内容"
                  className="w-full h-12 resize-none rounded bg-white/5 border border-white/10 px-2 py-1 text-[11px] text-white outline-none focus:border-sky-300/40 placeholder:text-white/25"
                />
              </div>
            )}
          </div>
        )}

        {isVidu && (
          <div className="rounded border border-violet-300/20 bg-violet-400/[0.06] p-2 space-y-2">
            {viduMode === 'short-play' && (
              <div>
                <label className="text-[10px] text-white/50 block mb-1">脚本名称（≤20 字符）</label>
                <input
                  value={viduScriptName}
                  maxLength={20}
                  onChange={(e) => update({ viduScriptName: e.target.value })}
                  className="w-full rounded bg-white/5 border border-white/10 px-2 py-1 text-xs text-white outline-none focus:border-violet-300/40"
                />
              </div>
            )}
            <div className="grid grid-cols-2 gap-1.5">
              <div>
                <label className="text-[10px] text-white/50 block mb-1">比例</label>
                <select
                  value={viduRatio}
                  onChange={(e) => update({ ratio: e.target.value })}
                  className="w-full rounded bg-white/5 border border-white/10 px-2 py-1 text-xs text-white outline-none focus:border-violet-300/40"
                >
                  {(viduMode === 'short-play' ? ['9:16', '16:9'] : ratioOptions).map((item) => (
                    <option key={item} value={item} className="bg-zinc-900">{item}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-[10px] text-white/50 block mb-1">时长(s)</label>
                <select
                  value={String(viduDuration)}
                  onChange={(e) => update({ duration: Number(e.target.value) })}
                  className="w-full rounded bg-white/5 border border-white/10 px-2 py-1 text-xs text-white outline-none focus:border-violet-300/40"
                >
                  {(viduMode === 'short-play' ? [8, 9, 10, 11, 12] : [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]).map((item) => (
                    <option key={item} value={item} className="bg-zinc-900">{item}s</option>
                  ))}
                </select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              <div>
                <label className="text-[10px] text-white/50 block mb-1">分辨率</label>
                <select
                  value={viduResolution}
                  disabled={viduMode === 'short-play'}
                  onChange={(e) => update({ resolution: e.target.value })}
                  className="w-full rounded bg-white/5 border border-white/10 px-2 py-1 text-xs text-white outline-none focus:border-violet-300/40 disabled:opacity-60"
                >
                  {(viduMode === 'short-play' ? ['1080p'] : ['default', '720p', '1080p']).map((item) => (
                    <option key={item} value={item} className="bg-zinc-900">{item}</option>
                  ))}
                </select>
              </div>
              {viduMode === 'short-play' ? (
                <div>
                  <label className="text-[10px] text-white/50 block mb-1">资产类型</label>
                  <select
                    value={viduAssetType}
                    onChange={(e) => update({ viduAssetType: e.target.value })}
                    className="w-full rounded bg-white/5 border border-white/10 px-2 py-1 text-xs text-white outline-none focus:border-violet-300/40"
                  >
                    {['character', 'scene', 'prop'].map((item) => (
                      <option key={item} value={item} className="bg-zinc-900">{item}</option>
                    ))}
                  </select>
                </div>
              ) : (
                <div>
                  <label className="text-[10px] text-white/50 block mb-1">Seed（-1 随机）</label>
                  <input
                    type="number"
                    min={-1}
                    max={2147483647}
                    value={viduSeed}
                    onChange={(e) => update({ viduSeed: Math.max(-1, Math.min(2147483647, Number(e.target.value) || 0)) })}
                    className="w-full rounded bg-white/5 border border-white/10 px-2 py-1 text-xs text-white outline-none focus:border-violet-300/40"
                  />
                </div>
              )}
            </div>
            {viduMode === 'short-play' && (
              <>
                <div>
                  <label className="text-[10px] text-white/50 block mb-1">视频风格（≤30 字符）</label>
                  <input
                    value={viduStyle}
                    maxLength={30}
                    onChange={(e) => update({ viduStyle: e.target.value })}
                    className="w-full rounded bg-white/5 border border-white/10 px-2 py-1 text-xs text-white outline-none focus:border-violet-300/40"
                  />
                </div>
                <div className="grid grid-cols-2 gap-1.5">
                  <div>
                    <label className="text-[10px] text-white/50 block mb-1">资产名称前缀</label>
                    <input
                      value={viduAssetNamePrefix}
                      onChange={(e) => update({ viduAssetNamePrefix: e.target.value })}
                      className="w-full rounded bg-white/5 border border-white/10 px-2 py-1 text-xs text-white outline-none focus:border-violet-300/40"
                    />
                  </div>
                  <div>
                    <label className="text-[10px] text-white/50 block mb-1">资产描述</label>
                    <input
                      value={viduAssetDescription}
                      onChange={(e) => update({ viduAssetDescription: e.target.value })}
                      className="w-full rounded bg-white/5 border border-white/10 px-2 py-1 text-xs text-white outline-none focus:border-violet-300/40"
                    />
                  </div>
                </div>
              </>
            )}
          </div>
        )}

        {isWan && durationOptions.length > 0 && (
          <div>
            <label className="text-[10px] text-white/50 block mb-1">时长(s)</label>
            <select
              value={String(duration)}
              onChange={(e) => update({ duration: Number(e.target.value) })}
              className="w-full rounded bg-white/5 border border-white/10 px-2 py-1 text-xs text-white outline-none focus:border-white/30"
            >
              {durationOptions.map((seconds) => (
                <option key={seconds} value={seconds} className="bg-zinc-900">{seconds}s</option>
              ))}
            </select>
          </div>
        )}

        {/* 分辨率(仅 grok 非FAL) */}
        {showGenericVideoControls && !isHailuo && !isKling && !isVidu && resolutionOptions.length > 0 && (
          <div>
            <label className="text-[10px] text-white/50 block mb-1">分辨率</label>
            <select
              value={resolution || resolutionOptions[0]}
              onChange={(e) => update({ resolution: e.target.value })}
              className="w-full rounded bg-white/5 border border-white/10 px-2 py-1 text-xs text-white outline-none focus:border-white/30"
            >
              {resolutionOptions.map((r) => (
                <option key={r} value={r} className="bg-zinc-900">{r}</option>
              ))}
            </select>
          </div>
        )}

        {isAgnesExternalSelected && (
          <div className="rounded border border-emerald-300/20 bg-emerald-400/[0.06] p-2 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10px] font-semibold text-white/75">Agnes 视频参数</span>
              <span className="text-[9px] text-emerald-100/60">/v1/videos</span>
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              <div>
                <label className="text-[10px] text-white/50 block mb-1">帧率</label>
                <select
                  value={String(agnesFrameRate)}
                  onChange={(e) => updateProviderParams({ frameRate: Number(e.target.value) || 24 })}
                  className="w-full rounded bg-white/5 border border-white/10 px-2 py-1 text-xs text-white outline-none focus:border-white/30"
                >
                  {[8, 12, 16, 24, 30].map((fps) => (
                    <option key={fps} value={fps} className="bg-zinc-900">{fps} fps</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-[10px] text-white/50 block mb-1">帧数覆盖</label>
                <input
                  type="number"
                  min={9}
                  max={441}
                  value={String(agnesNumFrames)}
                  onChange={(e) => updateProviderParams({
                    numFrames: e.target.value ? Math.max(9, Math.min(441, Number(e.target.value) || 9)) : '',
                  })}
                  placeholder="自动"
                  className="w-full rounded bg-white/5 border border-white/10 px-2 py-1 text-xs text-white outline-none focus:border-white/30 placeholder:text-white/25"
                />
              </div>
            </div>
            <div className="text-[10px] leading-relaxed text-white/45">
              默认由比例、分辨率和时长换算宽高与帧数；通常只需要调比例、时长和分辨率，特殊测试再覆盖帧数。
            </div>
          </div>
        )}

        {/* veo 专用选项(非FAL) */}
        {!isExternalSelected && !isFal && modelDef.kind === 'veo' && !isVeoOmni && !isApimartBudgetVideo && (
          <div className="grid grid-cols-2 gap-1.5">
            <label className="flex items-center gap-1 text-[10px] text-white/60 cursor-pointer">
              <input
                type="checkbox"
                checked={enhancePrompt}
                onChange={(e) => update({ enhancePrompt: e.target.checked })}
                className="accent-rose-400"
              />
              Enhance Prompt
            </label>
            <label className="flex items-center gap-1 text-[10px] text-white/60 cursor-pointer">
              <input
                type="checkbox"
                checked={enableUpsample}
                onChange={(e) => update({ enableUpsample: e.target.checked })}
                className="accent-rose-400"
              />
              Upsample
            </label>
          </div>
        )}

        {/* Seed(非FAL) */}
        {showGenericVideoControls && !isHappyHorse && !isKling && !isUpscaler && !isWan && !isApimartBudgetVideo && (
        <div>
          <label className="text-[10px] text-white/50 block mb-1">Seed (0=随机)</label>
          <input
            type="number"
            value={seed}
            min={0}
            max={2147483647}
            onChange={(e) => update({ seed: Number(e.target.value) || 0 })}
            className="w-full rounded bg-white/5 border border-white/10 px-2 py-1 text-xs text-white outline-none focus:border-white/30"
          />
        </div>
        )}

        {/* 上游素材聚合预览区 (代替原「参考图(上游)」计数提示) */}
        {(modelDef.supportImages || modelDef.supportVideos) && !isApimartV31Lite && (
          <MaterialPreviewSection
            texts={orderedTexts}
            images={orderedImages}
            videos={orderedVideos}
            audios={orderedAudios}
            order={materialOrder}
            onReorder={setMaterialOrder}
            onExcludeUpstream={handleExcludeUpstreamMaterial}
            excludedCount={excludedUpstreamCount}
            onRestoreExcluded={handleRestoreExcludedMaterials}
            selected={!!selected}
            isDark={isDark}
            isPixel={isPixel}
            groups={previewGroups}
            title={previewTitle}
          />
        )}

        {/* 本地拖入参考素材 (Ctrl+拖拽自其他节点) */}
        {(modelDef.supportImages || modelDef.supportVideos) && !isApimartV31Lite && (isUpscaler ? localRefVideos.length : localRefImages.length + localRefVideos.length + localRefAudios.length) > 0 && (
          <div className="rounded border border-emerald-400/30 bg-emerald-500/5 p-1.5 space-y-1">
            <div className="text-[10px] text-emerald-200/80">
              {isUpscaler ? `本地拖入 · 视频 ${localRefVideos.length}/1` : `本地拖入 · 图${localRefImages.length} 视${localRefVideos.length} 音${localRefAudios.length}`}
            </div>
            {!isUpscaler && localRefImages.length > 0 && (
              <div className="flex gap-1 flex-wrap">
                {localRefImages.map((u, i) => (
                  <div key={`img-${i}`} className="relative w-10 h-10">
                    <SmartImage
                      src={u}
                      alt=""
                      data-drag-source
                      data-drag-kind="image"
                      data-drag-url={u}
                      data-drag-preview={u}
                      data-drag-node-id={id}
                      onMouseDown={(e) => beginMaterialDrag(e, { kind: 'image', url: u, sourceNodeId: id, previewUrl: u })}
                      className="w-10 h-10 object-cover rounded border border-white/10 cursor-grab"
                      thumbSize={160}
                    />
                    <button
                      onClick={() => update({ localRefImages: localRefImages.filter((x) => x !== u) })}
                      className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-rose-500 text-white flex items-center justify-center"
                    >
                      <X size={9} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            {localRefVideos.length > 0 && (
              <div className="space-y-1">
                {localRefVideos.map((u, i) => (
                  <div key={`vid-${i}`} className="flex items-center gap-1">
                    <LoopingVideo
                      src={u}
                      data-drag-source
                      data-drag-kind="video"
                      data-drag-url={u}
                      data-drag-preview={u}
                      data-drag-node-id={id}
                      onMouseDown={(e) => beginMaterialDrag(e, { kind: 'video', url: u, sourceNodeId: id, previewUrl: u })}
                      className="w-12 h-8 object-cover rounded border border-white/10 cursor-grab"
                    />
                    <span className="flex-1 truncate text-[10px] text-white/50">{u.split('/').pop()}</span>
                    <button
                      onClick={() => update({ localRefVideos: localRefVideos.filter((x) => x !== u) })}
                      className="text-rose-300/60 hover:text-rose-200"
                    >
                      <X size={11} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            {!isUpscaler && localRefAudios.length > 0 && (
              <div className="space-y-1">
                {localRefAudios.map((u, i) => (
                  <div key={`aud-${i}`} className="flex items-center gap-1">
                    <span
                      data-drag-source
                      data-drag-kind="audio"
                      data-drag-url={u}
                      data-drag-node-id={id}
                      onMouseDown={(e) => beginMaterialDrag(e, { kind: 'audio', url: u, sourceNodeId: id, previewUrl: u })}
                      className="text-[14px] cursor-grab"
                      title="按住 Ctrl 拖拽"
                    >
                      ♪
                    </span>
                    <span className="flex-1 truncate text-[10px] text-white/50">{u.split('/').pop()}</span>
                    <button
                      onClick={() => update({ localRefAudios: localRefAudios.filter((x) => x !== u) })}
                      className="text-rose-300/60 hover:text-rose-200"
                    >
                      <X size={11} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Prompt */}
        {!isUpscaler && <div>
          <label className="text-[10px] text-white/50 block mb-1">
            {isVidu && viduMode === 'short-play'
              ? '短剧脚本内容（必填）'
              : isKling && klingMode !== 'i2v'
                ? '本地 Prompt（必填）'
                : '本地 Prompt(可选)'}
          </label>
          <MentionPromptInput
            title="视频 Prompt"
            value={localPrompt}
            mentions={promptMentions}
            materials={mentionMaterials}
            onChange={(value, mentions) => update({ prompt: value, promptMentions: mentions })}
            placeholder="备用:无上游连接时使用"
            isDark={isDark}
            isPixel={isPixel}
            promptTemplateKind="video"
            className="w-full h-12 resize-none rounded bg-white/5 border border-white/10 px-2 py-1 text-[11px] text-white outline-none focus:border-white/30 placeholder:text-white/30"
          />
        </div>}

        <ReuseResultToggle
          checked={d?.reuseResult === true}
          hasResult={hasReusableGenerationResult('video', d)}
          onChange={(checked) => update({ reuseResult: checked })}
          accentColor="#fb7185"
        />

        {!isBusy ? (
          <button
            onClick={() => requestCanvasNodeRun(id)}
            className="w-full flex items-center justify-center gap-1.5 py-1.5 rounded bg-rose-500/20 hover:bg-rose-500/30 text-rose-200 text-xs font-medium transition-colors"
          >
            <Sparkles size={12} /> {isUpscaler ? '开始超分' : '生成视频'}
          </button>
        ) : (
          <button
            onClick={handleStop}
            className="w-full flex items-center justify-center gap-1.5 py-1.5 rounded bg-zinc-500/20 hover:bg-zinc-500/30 text-zinc-200 text-xs font-medium transition-colors"
          >
            <Square size={11} /> 停止({progress || (status === 'submitting' ? '提交中' : '排队中')})
          </button>
        )}

        {isBusy && (
          <div className="flex items-center gap-1 text-[10px] text-rose-200/80">
            <Loader2 size={11} className="animate-spin" />
            {status === 'submitting' ? '提交任务...' : `轮询中 ${progress}`}
            {taskId && <span className="ml-auto text-white/30">{taskId.slice(0, 10)}…</span>}
          </div>
        )}

        {error && (
          <div className="flex items-start gap-1 text-[10px] text-red-300 bg-red-500/10 border border-red-500/20 rounded px-2 py-1">
            <AlertCircle size={11} className="mt-0.5 flex-shrink-0" />
            <span className="break-all">{normalizeProviderErrorMessage(error, '生成失败')}</span>
          </div>
        )}
      </div>

      {videoUrl && !hasAutoOutput && (
        <div className="border-t border-white/10 p-2">
          <LoopingVideo
            src={videoUrl}
            controls
            className="w-full rounded"
            style={{ aspectRatio: ratio.replace(':', '/') }}
            data-drag-source
            data-drag-kind="video"
            data-drag-url={videoUrl}
            data-drag-preview={videoUrl}
            data-drag-node-id={id}
            data-resource-title={videoUrl.split('/').pop() || '生成视频'}
            data-prompt-template-kind="video"
            data-prompt-template-category="video-image-to-video"
            data-prompt-template-prompt={d?.lastPrompt || localPrompt}
            onMouseDown={(e) => beginMaterialDrag(e, { kind: 'video', url: videoUrl, sourceNodeId: id, previewUrl: videoUrl })}
            title="按住 Ctrl 拖拽到其他节点"
          />
        </div>
      )}
    </div>
  );
};

export default memo(VideoNode);
