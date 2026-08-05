import {
  buildRhToolboxCapabilityInputValues,
  RH_IMAGE_CAPABILITY_PRESETS,
  RH_VIDEO_CAPABILITY_PRESETS,
  resolveRhToolboxCapability,
} from '../utils/rhToolboxCapabilities';
import type { RhToolboxTool } from '../utils/rhToolbox';
import { RH_SMART_TRANSLATION_TOOL_ID } from '../utils/rhToolbox';
import {
  getRhToolboxManifest,
  runRhToolboxTool,
  type RunRhToolboxProgress,
  type RunRhToolboxToolResult,
} from './rhToolbox';
import { getRhToolboxPersistentManifest } from './api';
import type { RhToolboxManifest } from '../utils/rhToolbox';
import { mergeRhToolboxManifests } from '../utils/rhToolbox';
import {
  protectSmartTranslationText,
  restoreSmartTranslationText,
} from '../utils/smartTranslation';

export interface RunRhImageCapabilityOptions {
  capability: string;
  imageUrl: string;
  preferredToolId?: string;
  userParams?: Record<string, string | number | boolean>;
  signal?: AbortSignal;
  onProgress?: (progress: RunRhToolboxProgress) => void;
}

export interface RunRhVideoCapabilityOptions {
  capability: string;
  videoUrl: string;
  preferredToolId?: string;
  userParams?: Record<string, string | number | boolean>;
  signal?: AbortSignal;
  onProgress?: (progress: RunRhToolboxProgress) => void;
}

export interface RunRhImageBatchItemProgress {
  index: number;
  total: number;
  imageUrl: string;
  attempt: number;
  maxAttempts: number;
  status: 'start' | 'retry' | 'success' | 'error' | 'cancelled';
  error?: string;
}

export interface RunRhVideoBatchItemProgress {
  index: number;
  total: number;
  videoUrl: string;
  attempt: number;
  maxAttempts: number;
  status: 'start' | 'retry' | 'success' | 'error' | 'cancelled';
  error?: string;
}

export interface RunRhImageCapabilityBatchOptions
  extends Omit<RunRhImageCapabilityOptions, 'imageUrl'> {
  imageUrls: string[];
  retryCount?: number;
  retryDelayMs?: number;
  continueOnError?: boolean;
  onItemProgress?: (progress: RunRhImageBatchItemProgress) => void;
}

export interface RunRhVideoCapabilityBatchOptions
  extends Omit<RunRhVideoCapabilityOptions, 'videoUrl'> {
  videoUrls: string[];
  retryCount?: number;
  retryDelayMs?: number;
  continueOnError?: boolean;
  onItemProgress?: (progress: RunRhVideoBatchItemProgress) => void;
}

export interface RunRhImageCapabilityResult {
  tool: RhToolboxTool;
  taskId: string;
  imageUrls: string[];
  outputUrl: string;
  result: RunRhToolboxToolResult;
  raw?: any;
}

export interface RunRhVideoCapabilityResult {
  tool: RhToolboxTool;
  taskId: string;
  videoUrls: string[];
  outputUrl: string;
  result: RunRhToolboxToolResult;
  raw?: any;
}

export interface RunRhTextTranslationOptions {
  text: string;
  protectedTerms?: string[];
  signal?: AbortSignal;
  onProgress?: (progress: RunRhToolboxProgress) => void;
}

export interface RunRhTextTranslationResult {
  tool: RhToolboxTool;
  taskId: string;
  translatedText: string;
  textOutputs: string[];
  result: RunRhToolboxToolResult;
  raw?: any;
}

export interface RunRhImageCapabilityBatchResult {
  tool: RhToolboxTool;
  taskIds: string[];
  imageUrls: string[];
  outputUrl: string;
  results: RunRhImageCapabilityResult[];
  failedItems: Array<{
    index: number;
    imageUrl: string;
    error: string;
    attempts: number;
  }>;
  cancelled: boolean;
}

export interface RunRhVideoCapabilityBatchResult {
  tool: RhToolboxTool;
  taskIds: string[];
  videoUrls: string[];
  outputUrl: string;
  results: RunRhVideoCapabilityResult[];
  failedItems: Array<{
    index: number;
    videoUrl: string;
    error: string;
    attempts: number;
  }>;
  cancelled: boolean;
}

const RH_TOOLBOX_DEVELOPER_MODULE = '../utils/rhToolboxDeveloper';

async function getRhToolboxCapabilityManifest(): Promise<RhToolboxManifest> {
  const base = getRhToolboxManifest();
  const persisted = await getRhToolboxPersistentManifest();
  const baseWithPersistent = persisted.success && persisted.data?.manifest
    ? mergeRhToolboxManifests(base, persisted.data.manifest)
    : base;
  if (!import.meta.env.DEV) return baseWithPersistent;
  try {
    const { mergeRhToolboxManifestWithDeveloperDrafts } = await import(/* @vite-ignore */ RH_TOOLBOX_DEVELOPER_MODULE);
    return mergeRhToolboxManifestWithDeveloperDrafts(baseWithPersistent);
  } catch {
    return baseWithPersistent;
  }
}

function imageOutputsFromResult(result: RunRhToolboxToolResult): string[] {
  if (result.imageUrls.length > 0) return result.imageUrls;
  return result.tool.outputSchema.some((output) => output.kind === 'image') ? result.urls : [];
}

function videoOutputsFromResult(result: RunRhToolboxToolResult): string[] {
  if (result.videoUrls.length > 0) return result.videoUrls;
  // 进入本服务的均是“输出视频”的能力。制作器旧持久清单曾把视频抠像
  // 错标为 image output；无扩展名签名 URL 也无法只靠后缀分类。
  // 因此在已确认的视频能力上下文中，保留全部 RH 结果作为视频兜底。
  return result.urls;
}

function cleanImageUrls(imageUrls: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of imageUrls) {
    const url = String(raw || '').trim();
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}

function cleanVideoUrls(videoUrls: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of videoUrls) {
    const url = String(raw || '').trim();
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error || 'RH 工具箱能力调用失败');
}

function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  if (error instanceof Error) return error.name === 'AbortError' || error.message === '已取消';
  return String(error || '') === '已取消';
}

function delayBeforeRetry(ms: number, signal?: AbortSignal): Promise<void> {
  const safeMs = Math.max(0, Math.floor(ms));
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('已取消'));
      return;
    }
    const timer = window.setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, safeMs);
    const onAbort = () => {
      window.clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(new Error('已取消'));
    };
    signal?.addEventListener('abort', onAbort);
  });
}

export async function runRhImageCapability(
  options: RunRhImageCapabilityOptions,
): Promise<RunRhImageCapabilityResult> {
  const manifest = await getRhToolboxCapabilityManifest();
  const tool = resolveRhToolboxCapability(manifest, {
    surface: 'image',
    capability: options.capability,
    preferredToolId: options.preferredToolId,
  });
  if (!tool) throw new Error(`未找到可用 RH 图像能力：${options.capability}`);

  const inputValues = buildRhToolboxCapabilityInputValues(tool, 'image', options.imageUrl);
  const result = await runRhToolboxTool({
    toolId: tool.id,
    manifest,
    inputValues,
    userParams: options.userParams,
    signal: options.signal,
    onProgress: options.onProgress,
  });
  const imageUrls = imageOutputsFromResult(result);
  if (imageUrls.length === 0) {
    throw new Error(`${tool.title} 未返回图像结果`);
  }
  return {
    tool,
    taskId: result.taskId,
    imageUrls,
    outputUrl: imageUrls[0],
    result,
    raw: result.raw,
  };
}

export async function runRhVideoCapability(
  options: RunRhVideoCapabilityOptions,
): Promise<RunRhVideoCapabilityResult> {
  const manifest = await getRhToolboxCapabilityManifest();
  const tool = resolveRhToolboxCapability(manifest, {
    surface: 'video',
    capability: options.capability,
    preferredToolId: options.preferredToolId,
  });
  if (!tool) throw new Error(`未找到可用 RH 视频能力：${options.capability}`);

  const inputValues = buildRhToolboxCapabilityInputValues(tool, 'video', options.videoUrl);
  const result = await runRhToolboxTool({
    toolId: tool.id,
    manifest,
    inputValues,
    userParams: options.userParams,
    signal: options.signal,
    onProgress: options.onProgress,
  });
  const videoUrls = videoOutputsFromResult(result);
  if (videoUrls.length === 0) {
    throw new Error(`${tool.title} 未返回视频结果`);
  }
  return {
    tool,
    taskId: result.taskId,
    videoUrls,
    outputUrl: videoUrls[0],
    result,
    raw: result.raw,
  };
}

/**
 * Shared RH smart-translation capability used by the toolbox and node UI.
 * It performs exactly one provider submission per click and fails closed when
 * the WebApp returns no text or drops protected @ media-reference tokens.
 */
export async function runRhTextTranslation(
  options: RunRhTextTranslationOptions,
): Promise<RunRhTextTranslationResult> {
  const protectedText = protectSmartTranslationText(options.text, options.protectedTerms);
  const manifest = await getRhToolboxCapabilityManifest();
  const tool = resolveRhToolboxCapability(manifest, {
    surface: 'text',
    capability: 'text.translate',
    preferredToolId: RH_SMART_TRANSLATION_TOOL_ID,
  });
  if (!tool) throw new Error('未找到可用的 RH 智能翻译能力');

  const inputValues = buildRhToolboxCapabilityInputValues(tool, 'text', protectedText.requestText);
  const result = await runRhToolboxTool({
    toolId: tool.id,
    manifest,
    inputValues,
    signal: options.signal,
    onProgress: options.onProgress,
  });
  const rawText = result.textOutputs.map((value) => String(value || '').trim()).filter(Boolean).join('\n\n');
  const translatedText = restoreSmartTranslationText(rawText, protectedText.replacements);
  return {
    tool,
    taskId: result.taskId,
    translatedText,
    textOutputs: [translatedText],
    result,
    raw: result.raw,
  };
}

export async function runRhImageCapabilityBatch(
  options: RunRhImageCapabilityBatchOptions,
): Promise<RunRhImageCapabilityBatchResult> {
  const cleanUrls = cleanImageUrls(options.imageUrls);
  if (cleanUrls.length === 0) throw new Error('缺少要处理的图像素材');

  const retryCount = Math.max(0, Math.floor(options.retryCount ?? 2));
  const retryDelayMs = options.retryDelayMs ?? 1200;
  const maxAttempts = retryCount + 1;
  const continueOnError = options.continueOnError ?? true;
  const results: RunRhImageCapabilityResult[] = [];
  const failedItems: RunRhImageCapabilityBatchResult['failedItems'] = [];
  const imageUrls: string[] = [];
  let cancelled = false;

  for (let index = 0; index < cleanUrls.length && !cancelled; index += 1) {
    const imageUrl = cleanUrls[index];
    let itemDone = false;

    for (let attempt = 1; attempt <= maxAttempts && !itemDone; attempt += 1) {
      if (options.signal?.aborted) {
        cancelled = true;
        options.onItemProgress?.({ index, total: cleanUrls.length, imageUrl, attempt, maxAttempts, status: 'cancelled' });
        break;
      }

      options.onItemProgress?.({ index, total: cleanUrls.length, imageUrl, attempt, maxAttempts, status: 'start' });
      try {
        const result = await runRhImageCapability({
          capability: options.capability,
          imageUrl,
          preferredToolId: options.preferredToolId,
          userParams: options.userParams,
          signal: options.signal,
          onProgress: (progress) => {
            const attemptText = maxAttempts > 1 ? ` · 尝试 ${attempt}/${maxAttempts}` : '';
            options.onProgress?.({
              ...progress,
              message: `第 ${index + 1}/${cleanUrls.length} 张${attemptText} · ${progress.message}`,
            });
          },
        });
        results.push(result);
        imageUrls.push(...result.imageUrls);
        options.onItemProgress?.({ index, total: cleanUrls.length, imageUrl, attempt, maxAttempts, status: 'success' });
        itemDone = true;
      } catch (error) {
        const message = formatError(error);
        if (isAbortError(error, options.signal)) {
          cancelled = true;
          options.onItemProgress?.({ index, total: cleanUrls.length, imageUrl, attempt, maxAttempts, status: 'cancelled', error: message });
          break;
        }

        const hasRetryLeft = attempt < maxAttempts;
        if (hasRetryLeft) {
          options.onItemProgress?.({ index, total: cleanUrls.length, imageUrl, attempt, maxAttempts, status: 'retry', error: message });
          options.onProgress?.({
            stage: 'error',
            message: `第 ${index + 1}/${cleanUrls.length} 张失败，${Math.max(0, maxAttempts - attempt)} 次重试剩余：${message}`,
          });
          try {
            await delayBeforeRetry(retryDelayMs, options.signal);
          } catch (retryError) {
            if (isAbortError(retryError, options.signal)) {
              cancelled = true;
              options.onItemProgress?.({
                index,
                total: cleanUrls.length,
                imageUrl,
                attempt,
                maxAttempts,
                status: 'cancelled',
                error: formatError(retryError),
              });
              break;
            }
            throw retryError;
          }
          continue;
        }

        failedItems.push({ index, imageUrl, error: message, attempts: attempt });
        options.onItemProgress?.({ index, total: cleanUrls.length, imageUrl, attempt, maxAttempts, status: 'error', error: message });
        if (!continueOnError) {
          throw error;
        }
      }
    }
  }

  if (results.length === 0 || imageUrls.length === 0) {
    if (cancelled) throw new Error('已取消');
    if (failedItems.length > 0) {
      throw new Error(`RH 图像批处理全部失败：${failedItems[0].error}`);
    }
    throw new Error('RH 图像批处理未返回图像结果');
  }
  return {
    tool: results[0].tool,
    taskIds: results.map((result) => result.taskId),
    imageUrls,
    outputUrl: imageUrls[0],
    results,
    failedItems,
    cancelled,
  };
}

export async function runRhVideoCapabilityBatch(
  options: RunRhVideoCapabilityBatchOptions,
): Promise<RunRhVideoCapabilityBatchResult> {
  const cleanUrls = cleanVideoUrls(options.videoUrls);
  if (cleanUrls.length === 0) throw new Error('缺少要处理的视频素材');

  const retryCount = Math.max(0, Math.floor(options.retryCount ?? 2));
  const retryDelayMs = options.retryDelayMs ?? 1200;
  const maxAttempts = retryCount + 1;
  const continueOnError = options.continueOnError ?? true;
  const results: RunRhVideoCapabilityResult[] = [];
  const failedItems: RunRhVideoCapabilityBatchResult['failedItems'] = [];
  const videoUrls: string[] = [];
  let cancelled = false;

  for (let index = 0; index < cleanUrls.length && !cancelled; index += 1) {
    const videoUrl = cleanUrls[index];
    let itemDone = false;

    for (let attempt = 1; attempt <= maxAttempts && !itemDone; attempt += 1) {
      if (options.signal?.aborted) {
        cancelled = true;
        options.onItemProgress?.({ index, total: cleanUrls.length, videoUrl, attempt, maxAttempts, status: 'cancelled' });
        break;
      }

      options.onItemProgress?.({ index, total: cleanUrls.length, videoUrl, attempt, maxAttempts, status: 'start' });
      try {
        const result = await runRhVideoCapability({
          capability: options.capability,
          videoUrl,
          preferredToolId: options.preferredToolId,
          userParams: options.userParams,
          signal: options.signal,
          onProgress: (progress) => {
            const attemptText = maxAttempts > 1 ? ` · 尝试 ${attempt}/${maxAttempts}` : '';
            options.onProgress?.({
              ...progress,
              message: `第 ${index + 1}/${cleanUrls.length} 个视频${attemptText} · ${progress.message}`,
            });
          },
        });
        results.push(result);
        videoUrls.push(...result.videoUrls);
        options.onItemProgress?.({ index, total: cleanUrls.length, videoUrl, attempt, maxAttempts, status: 'success' });
        itemDone = true;
      } catch (error) {
        const message = formatError(error);
        if (isAbortError(error, options.signal)) {
          cancelled = true;
          options.onItemProgress?.({ index, total: cleanUrls.length, videoUrl, attempt, maxAttempts, status: 'cancelled', error: message });
          break;
        }

        const hasRetryLeft = attempt < maxAttempts;
        if (hasRetryLeft) {
          options.onItemProgress?.({ index, total: cleanUrls.length, videoUrl, attempt, maxAttempts, status: 'retry', error: message });
          options.onProgress?.({
            stage: 'error',
            message: `第 ${index + 1}/${cleanUrls.length} 个视频失败，${Math.max(0, maxAttempts - attempt)} 次重试剩余：${message}`,
          });
          try {
            await delayBeforeRetry(retryDelayMs, options.signal);
          } catch (retryError) {
            if (isAbortError(retryError, options.signal)) {
              cancelled = true;
              options.onItemProgress?.({
                index,
                total: cleanUrls.length,
                videoUrl,
                attempt,
                maxAttempts,
                status: 'cancelled',
                error: formatError(retryError),
              });
              break;
            }
            throw retryError;
          }
          continue;
        }

        failedItems.push({ index, videoUrl, error: message, attempts: attempt });
        options.onItemProgress?.({ index, total: cleanUrls.length, videoUrl, attempt, maxAttempts, status: 'error', error: message });
        if (!continueOnError) {
          throw error;
        }
      }
    }
  }

  if (results.length === 0 || videoUrls.length === 0) {
    if (cancelled) throw new Error('已取消');
    if (failedItems.length > 0) {
      throw new Error(`RH 视频批处理全部失败：${failedItems[0].error}`);
    }
    throw new Error('RH 视频批处理未返回视频结果');
  }
  return {
    tool: results[0].tool,
    taskIds: results.map((result) => result.taskId),
    videoUrls,
    outputUrl: videoUrls[0],
    results,
    failedItems,
    cancelled,
  };
}

export function runRhImageCutout(
  imageUrl: string,
  options: Omit<RunRhImageCapabilityOptions, 'capability' | 'imageUrl' | 'preferredToolId'> = {},
): Promise<RunRhImageCapabilityResult> {
  return runRhImageCapability({
    ...options,
    capability: 'image.cutout',
    imageUrl,
    preferredToolId: 'image-cutout-v1',
  });
}

export function runRhImageUpscale(
  imageUrl: string,
  options: Omit<RunRhImageCapabilityOptions, 'capability' | 'imageUrl' | 'preferredToolId'> = {},
): Promise<RunRhImageCapabilityResult> {
  return runRhImageCapability({
    ...options,
    capability: 'image.upscale',
    imageUrl,
    preferredToolId: 'image-upscale-4k',
  });
}

export function runRhImageExpand(
  imageUrl: string,
  options: Omit<RunRhImageCapabilityOptions, 'capability' | 'imageUrl'> & { presetId?: string } = {},
): Promise<RunRhImageCapabilityResult> {
  const preset = RH_IMAGE_CAPABILITY_PRESETS.expand.paramPresets?.find((item) => item.id === options.presetId)
    || RH_IMAGE_CAPABILITY_PRESETS.expand.paramPresets?.find((item) => item.id === RH_IMAGE_CAPABILITY_PRESETS.expand.defaultParamPresetId)
    || RH_IMAGE_CAPABILITY_PRESETS.expand.paramPresets?.[0];
  const { presetId: _presetId, userParams, ...rest } = options;
  return runRhImageCapability({
    ...rest,
    capability: 'image.expand',
    imageUrl,
    userParams: {
      ...(preset?.userParams || {}),
      ...(userParams || {}),
    },
  });
}

export function runRhImageCutoutBatch(
  imageUrls: string[],
  options: Omit<RunRhImageCapabilityBatchOptions, 'capability' | 'imageUrls' | 'preferredToolId'> = {},
): Promise<RunRhImageCapabilityBatchResult> {
  return runRhImageCapabilityBatch({
    ...options,
    capability: 'image.cutout',
    imageUrls,
    preferredToolId: 'image-cutout-v1',
  });
}

export function runRhVideoFastUpscale(
  videoUrl: string,
  options: Omit<RunRhVideoCapabilityOptions, 'capability' | 'videoUrl' | 'preferredToolId'> = {},
): Promise<RunRhVideoCapabilityResult> {
  return runRhVideoCapability({
    ...options,
    capability: RH_VIDEO_CAPABILITY_PRESETS.fastUpscale.capability,
    videoUrl,
    preferredToolId: RH_VIDEO_CAPABILITY_PRESETS.fastUpscale.preferredToolId,
  });
}

export function runRhVideoCutout(
  videoUrl: string,
  options: Omit<RunRhVideoCapabilityOptions, 'capability' | 'videoUrl' | 'preferredToolId'> = {},
): Promise<RunRhVideoCapabilityResult> {
  return runRhVideoCapability({
    ...options,
    capability: RH_VIDEO_CAPABILITY_PRESETS.cutout.capability,
    videoUrl,
    preferredToolId: RH_VIDEO_CAPABILITY_PRESETS.cutout.preferredToolId,
  });
}

export function runRhVideoQualityUpscale(
  videoUrl: string,
  options: Omit<RunRhVideoCapabilityOptions, 'capability' | 'videoUrl' | 'preferredToolId'> = {},
): Promise<RunRhVideoCapabilityResult> {
  return runRhVideoCapability({
    ...options,
    capability: RH_VIDEO_CAPABILITY_PRESETS.qualityUpscale.capability,
    videoUrl,
    preferredToolId: RH_VIDEO_CAPABILITY_PRESETS.qualityUpscale.preferredToolId,
  });
}
