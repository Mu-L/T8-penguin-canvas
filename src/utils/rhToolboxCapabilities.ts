import {
  findRhToolboxToolById,
  getRhToolboxToolMajorCategory,
  listRhToolboxTools,
  normalizeRhToolboxManifest,
  type RhToolboxManifest,
  type RhToolboxMediaKind,
  type RhToolboxQuickSurface,
  type RhToolboxTool,
} from './rhToolbox.ts';

export interface RhToolboxCapabilityRequest {
  surface: RhToolboxQuickSurface;
  capability: string;
  preferredToolId?: string;
  includeDisabled?: boolean;
}

export interface RhImageCapabilityPreset {
  id: string;
  label: string;
  shortLabel?: string;
  capability: string;
  title: string;
  preferredToolId?: string;
  icon?: 'scissors' | 'sparkles' | 'expand' | 'eraser';
  defaultParamPresetId?: string;
  paramPresets?: RhImageCapabilityParamPreset[];
}

export interface RhVideoCapabilityPreset {
  id: string;
  label: string;
  shortLabel?: string;
  capability: string;
  title: string;
  preferredToolId?: string;
  icon?: 'zap' | 'sparkles' | 'scissors';
}

export interface RhImageCapabilityParamPreset {
  id: string;
  label: string;
  title?: string;
  userParams: Record<string, string | number | boolean>;
}

function createExpandResolutionPreset(
  id: string,
  ratioLabel: string,
  runningHubValue: string,
  width?: number,
  height?: number,
): RhImageCapabilityParamPreset {
  const hasSize = Number.isFinite(width) && Number.isFinite(height);
  const resolution = hasSize ? `${width}x${height}` : runningHubValue;
  const direction = !hasSize ? '' : width === height ? 'square' : width! > height! ? 'landscape' : 'portrait';
  return {
    id,
    label: hasSize ? `${ratioLabel} ${resolution}` : ratioLabel,
    title: hasSize ? `${ratioLabel} ${resolution}` : ratioLabel,
    userParams: {
      expand_size: runningHubValue,
      target_size: runningHubValue,
      output_size: runningHubValue,
      aspect_ratio: hasSize ? `${ratioLabel} ${direction} ${resolution}` : runningHubValue,
      aspectRatio: ratioLabel,
      resolution,
      size: resolution,
      ...(hasSize ? { width: width!, height: height! } : {}),
    },
  };
}

const RH_EXPAND_RESOLUTION_PRESETS: RhImageCapabilityParamPreset[] = [
  createExpandResolutionPreset('original', '原始比例', '原始比例'),
  createExpandResolutionPreset('square-1-1', '1:1', '1：1（1024x1024）', 1024, 1024),
  createExpandResolutionPreset('portrait-1-2', '1:2', '1：2（720x1456）', 720, 1456),
  createExpandResolutionPreset('portrait-2-3', '2:3', '2：3（832x1248）', 832, 1248),
  createExpandResolutionPreset('portrait-3-4', '3:4', '3：4（880x1184）', 880, 1184),
  createExpandResolutionPreset('portrait-3-5', '3:5', '3：5（800x1328）', 800, 1328),
  createExpandResolutionPreset('portrait-9-16', '9:16', '9：16（752x1392）', 752, 1392),
  createExpandResolutionPreset('portrait-9-21', '9:21', '9：21（672x1568）', 672, 1568),
  createExpandResolutionPreset('landscape-2-1', '2:1', '2：1（1456x720）', 1456, 720),
  createExpandResolutionPreset('landscape-3-2', '3:2', '3：2（1248x832）', 1248, 832),
  createExpandResolutionPreset('landscape-4-3', '4:3', '4：3（1184x880）', 1184, 880),
  createExpandResolutionPreset('landscape-5-3', '5:3', '5：3（1328x800）', 1328, 800),
  createExpandResolutionPreset('landscape-16-9', '16:9', '16：9（1392x752）', 1392, 752),
  createExpandResolutionPreset('wide-21-9', '21:9', '21：9（1568x672）', 1568, 672),
];

export const RH_IMAGE_CAPABILITY_PRESETS = {
  cutout: {
    id: 'cutout',
    label: '抠图',
    shortLabel: '抠图',
    title: '调用 RH工具箱 高清抠图，并把结果输出为新素材节点',
    capability: 'image.cutout',
    preferredToolId: 'image-cutout-v1',
    icon: 'scissors',
  },
  upscale: {
    id: 'upscale',
    label: '4K放大',
    shortLabel: '4K',
    title: '调用 RH工具箱 高清放大4K，并把结果输出为新素材节点',
    capability: 'image.upscale',
    preferredToolId: 'image-upscale-4k',
    icon: 'sparkles',
  },
  expand: {
    id: 'expand',
    label: '扩图',
    shortLabel: '扩图',
    title: '调用 RH工具箱 扩图能力；先选择目标分辨率，再把结果输出为新素材节点',
    capability: 'image.expand',
    icon: 'expand',
    defaultParamPresetId: 'landscape-16-9',
    paramPresets: RH_EXPAND_RESOLUTION_PRESETS,
  },
  removeSubject: {
    id: 'removeSubject',
    label: '消除主体',
    shortLabel: '消除',
    title: '调用 RH工具箱 消除主体能力，并把结果输出为新素材节点',
    capability: 'image.remove-subject',
    preferredToolId: 'xiaochuzhuti',
    icon: 'eraser',
  },
} as const satisfies Record<string, RhImageCapabilityPreset>;

export type RhImageCapabilityPresetId = keyof typeof RH_IMAGE_CAPABILITY_PRESETS;

export const RH_IMAGE_NODE_CAPABILITY_PRESETS: RhImageCapabilityPresetId[] = ['cutout', 'upscale', 'expand', 'removeSubject'];

export const RH_VIDEO_CAPABILITY_PRESETS = {
  cutout: {
    id: 'cutout',
    label: '抠像',
    shortLabel: '抠像',
    title: '调用 RH工具箱 视频抠像，并把透明背景视频输出为新素材节点',
    capability: 'video.cutout',
    preferredToolId: 'video-removebg-v1',
    icon: 'scissors',
  },
  fastUpscale: {
    id: 'fastUpscale',
    label: '极速超分',
    shortLabel: '极速',
    title: '调用 RH工具箱 英伟达极速超分，并把高清视频输出为新素材节点',
    capability: 'video.upscale',
    preferredToolId: 'video-nividia-upscale',
    icon: 'zap',
  },
  qualityUpscale: {
    id: 'qualityUpscale',
    label: '质量超分',
    shortLabel: '质量',
    title: '调用 RH工具箱 FlashVsr慢速超分，并把高清视频输出为新素材节点',
    capability: 'video.upscale',
    preferredToolId: 'video-flashvsr',
    icon: 'sparkles',
  },
} as const satisfies Record<string, RhVideoCapabilityPreset>;

export type RhVideoCapabilityPresetId = keyof typeof RH_VIDEO_CAPABILITY_PRESETS;

export const RH_VIDEO_NODE_CAPABILITY_PRESETS: RhVideoCapabilityPresetId[] = ['cutout', 'fastUpscale', 'qualityUpscale'];

const CAPABILITY_TITLE_MATCHERS: Record<string, RegExp> = {
  'image.expand': /扩图|扩画|外扩|补景|outpaint|uncrop|expand/i,
  'image.remove-subject': /消除主体|移除主体|去主体|主体消除|主体移除|remove\s*subject|subject\s*remov/i,
  'video.cutout': /视频抠像|视频去背|视频背景移除|video\s*(?:cutout|remove\s*bg|background\s*remov)/i,
  'video.upscale': /超分|放大|高清|upscale|super.?resolution|vsr/i,
};

const CAPABILITY_COMPATIBLE_TAGS: Record<string, string[]> = {
  'image.expand': ['image.edit'],
  'image.remove-subject': ['image.edit', 'image.cutout'],
};

const SURFACE_UI_FLAGS: Record<RhToolboxQuickSurface, keyof NonNullable<RhToolboxTool['ui']>> = {
  image: 'showInImageEditor',
  video: 'showInVideoEditor',
  text: 'showInTextEditor',
  audio: 'showInAudioEditor',
};

function isToolEnabled(tool: RhToolboxTool): boolean {
  return tool.enabled !== false && String(tool.webappId || '').trim() !== '';
}

function supportsSurface(tool: RhToolboxTool, manifest: RhToolboxManifest, surface: RhToolboxQuickSurface): boolean {
  const uiFlag = SURFACE_UI_FLAGS[surface];
  return (
    tool.ui?.[uiFlag] === true ||
    getRhToolboxToolMajorCategory(tool, manifest.categories) === surface ||
    tool.capabilities.some((capability) => capability.startsWith(`${surface}.`)) ||
    tool.inputSchema.some((input) => input.kind === surface) ||
    tool.outputSchema.some((output) => output.kind === surface)
  );
}

function categoryTextForTool(tool: RhToolboxTool, manifest: RhToolboxManifest): string {
  const category = manifest.categories.find((item) => item.id === tool.categoryId);
  return `${category?.name || ''} ${category?.description || ''}`;
}

function capabilityMatchScore(tool: RhToolboxTool, manifest: RhToolboxManifest, request: RhToolboxCapabilityRequest): number {
  if (tool.capabilities.includes(request.capability)) return 100;
  const matcher = CAPABILITY_TITLE_MATCHERS[request.capability];
  if (!matcher) return 0;
  const text = `${tool.id} ${tool.title} ${tool.description || ''} ${categoryTextForTool(tool, manifest)}`;
  if (!matcher.test(text)) return 0;
  const compatibleTags = CAPABILITY_COMPATIBLE_TAGS[request.capability] || [];
  if (compatibleTags.length === 0 || compatibleTags.some((tag) => tool.capabilities.includes(tag))) return 80;
  return 0;
}

function toolMatchesCapability(tool: RhToolboxTool, manifest: RhToolboxManifest, request: RhToolboxCapabilityRequest): boolean {
  return capabilityMatchScore(tool, manifest, request) > 0;
}

function capabilityRank(tool: RhToolboxTool, request: RhToolboxCapabilityRequest): number {
  let score = 0;
  if (tool.id === request.preferredToolId) score += 1000;
  if (tool.capabilities.includes(request.capability)) score += 100;
  if (tool.ui?.[SURFACE_UI_FLAGS[request.surface]] === true) score += 10;
  if (isToolEnabled(tool)) score += 1;
  return score;
}

export function resolveRhToolboxCapability(
  manifestInput: Partial<RhToolboxManifest> | null | undefined,
  request: RhToolboxCapabilityRequest,
): RhToolboxTool | undefined {
  const manifest = normalizeRhToolboxManifest(manifestInput);
  if (request.preferredToolId) {
    const preferred = findRhToolboxToolById(manifest, request.preferredToolId);
    if (
      preferred &&
      toolMatchesCapability(preferred, manifest, request) &&
      supportsSurface(preferred, manifest, request.surface) &&
      (request.includeDisabled || isToolEnabled(preferred))
    ) {
      return preferred;
    }
  }

  return listRhToolboxTools(manifest, { includeDisabled: request.includeDisabled })
    .filter((tool) => toolMatchesCapability(tool, manifest, request))
    .filter((tool) => supportsSurface(tool, manifest, request.surface))
    .filter((tool) => request.includeDisabled || isToolEnabled(tool))
    .sort((a, b) => (
      (capabilityRank(b, request) + capabilityMatchScore(b, manifest, request)) -
      (capabilityRank(a, request) + capabilityMatchScore(a, manifest, request)) ||
      (a.order || 0) - (b.order || 0) ||
      a.title.localeCompare(b.title, 'zh-Hans-CN')
    ))[0];
}

export function resolveRhImageCapabilityPreset(
  preset: RhImageCapabilityPresetId | RhImageCapabilityPreset | string | null | undefined,
): RhImageCapabilityPreset {
  if (!preset) return RH_IMAGE_CAPABILITY_PRESETS.cutout;
  if (typeof preset === 'string') {
    const known = (RH_IMAGE_CAPABILITY_PRESETS as Record<string, RhImageCapabilityPreset>)[preset];
    if (known) return known;
    return {
      id: preset,
      label: preset,
      title: `调用 RH工具箱 ${preset}`,
      capability: preset,
    };
  }
  return preset;
}

export function resolveRhVideoCapabilityPreset(
  preset: RhVideoCapabilityPresetId | RhVideoCapabilityPreset | string | null | undefined,
): RhVideoCapabilityPreset {
  if (!preset) return RH_VIDEO_CAPABILITY_PRESETS.fastUpscale;
  if (typeof preset === 'string') {
    const known = (RH_VIDEO_CAPABILITY_PRESETS as Record<string, RhVideoCapabilityPreset>)[preset];
    if (known) return known;
    return {
      id: preset,
      label: preset,
      title: `调用 RH工具箱 ${preset}`,
      capability: preset,
    };
  }
  return preset;
}

export function buildRhToolboxCapabilityInputValues(
  tool: RhToolboxTool | null | undefined,
  sourceKind: RhToolboxMediaKind,
  sourceUrl: string,
): Record<string, string | string[]> {
  if (!tool) throw new Error('未找到可用的 RH 工具箱能力');
  const cleanUrl = String(sourceUrl || '').trim();
  if (!cleanUrl) throw new Error('缺少要处理的素材');
  const input =
    tool.inputSchema.find((item) => item.kind === sourceKind && item.required !== false) ||
    tool.inputSchema.find((item) => item.kind === sourceKind);
  if (!input) throw new Error(`${tool.title} 不支持 ${sourceKind} 输入`);
  return {
    [input.key]: input.multiple ? [cleanUrl] : cleanUrl,
  };
}
