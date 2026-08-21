import type { AdvancedProviderConfig } from '../types/canvas';
import {
  analyzeComfyWorkflow,
  comfyFieldInputValue,
  comfyFieldOptionsForWorkflow,
  compactComfyFields,
  filterComfyFieldsByExcludeRules,
  type ComfyFieldMapping,
} from './comfyuiWorkflow.ts';

export type ComfyAppMediaKind = 'text' | 'image' | 'video' | 'audio';
export type ComfyAppParamKind = 'text' | 'textarea' | 'number' | 'boolean' | 'select';

export interface ComfyAppCategory {
  id: string;
  name: string;
  description?: string;
  icon?: string;
  order?: number;
}

export interface ComfyAppUserParam {
  key: string;
  label: string;
  kind: ComfyAppParamKind;
  source: string;
  nodeId?: string;
  fieldName?: string;
  nodeTitle?: string;
  defaultValue?: string | number | boolean;
  placeholder?: string;
  required?: boolean;
  min?: number;
  max?: number;
  step?: number;
  options?: Array<string | number>;
  rows?: number;
}

export interface ComfyAppOutputMapping {
  key: string;
  label?: string;
  kind: ComfyAppMediaKind;
}

export interface ComfyAppDefinition {
  id: string;
  title: string;
  categoryId: string;
  description?: string;
  workflowJson: Record<string, any>;
  /** Missing/empty keeps the legacy behavior of collecting every workflow output. */
  outputNodeIds?: string[];
  fields: ComfyFieldMapping[];
  userParams: ComfyAppUserParam[];
  outputs: ComfyAppOutputMapping[];
  capabilities?: string[];
  runtime?: {
    pollIntervalMs?: number;
    maxPolls?: number;
  };
  ui?: {
    icon?: string;
    accent?: string;
  };
  version?: number;
  updatedAt?: string;
}

export interface ComfyAppManifest {
  schema: 't8-comfyui-app-manifest';
  version: number;
  updatedAt?: string;
  categories: ComfyAppCategory[];
  apps: ComfyAppDefinition[];
}

export interface ComfyAppInputRequirements {
  images: number;
  videos: number;
  audios: number;
}

const STORAGE_KEY = 't8-comfyui-app-manifest';
export const COMFY_APP_MANIFEST_EVENT = 'penguin:comfyui-app-manifest-updated';
export const COMFY_APP_ALL_CATEGORY_ID = 'all';

const DEFAULT_CATEGORY_ID = 'general';
const TEXT_SOURCES = new Set(['prompt', 'positive', 'negative']);
const MEDIA_SOURCE_RE = /^(image|video|audio)(?:_|-)?\d+$/i;
const EXPOSED_SOURCES = new Set([
  'prompt',
  'positive',
  'negative',
  'width',
  'height',
  'batch_size',
  'seed',
  'steps',
  'cfg',
  'sampler_name',
  'scheduler',
  'denoise',
  'model_name',
  'ckpt_name',
  'clip_name',
  'vae_name',
  'lora_name',
  'unet_name',
  'control_net_name',
  'clip_vision_name',
  'style_model_name',
  'upscale_model',
  'strength_model',
  'strength_clip',
  'start_at_step',
  'end_at_step',
  'guidance',
  'shift',
  'fps',
  'frame_rate',
  'num_frames',
  'duration',
  'strength',
  'weight',
  'control_after_generate',
  'add_noise',
]);
const SAFE_CUSTOM_SOURCE_RE = /^[a-z][a-z0-9_:. -]{0,79}$/i;
const BLOCKED_CUSTOM_SOURCES = new Set([
  'fixed',
  'model',
  'clip',
  'vae',
  'latent',
  'latent_image',
  'samples',
  'images',
  'conditioning',
  'control_net',
]);
const SHARED_DUPLICATE_SOURCES = new Set([
  ...TEXT_SOURCES,
  'width',
  'height',
  'batch_size',
  'seed',
]);

export const COMFY_APP_SOURCE_LABELS: Record<string, string> = {
  prompt: '正向 Prompt',
  positive: '正向 Prompt',
  negative: '负向 Prompt',
  image1: '图片输入 1',
  image2: '图片输入 2',
  image3: '图片输入 3',
  image4: '图片输入 4',
  image5: '图片输入 5',
  image6: '图片输入 6',
  video1: '视频输入 1',
  video2: '视频输入 2',
  video3: '视频输入 3',
  audio1: '音频输入 1',
  audio2: '音频输入 2',
  audio3: '音频输入 3',
  width: '宽度',
  height: '高度',
  batch_size: '批量数',
  seed: 'Seed',
  steps: 'Steps',
  cfg: 'CFG',
  sampler_name: 'Sampler',
  scheduler: 'Scheduler',
  denoise: 'Denoise',
  model_name: '模型名',
  ckpt_name: 'Checkpoint',
  clip_name: 'CLIP',
  vae_name: 'VAE',
  lora_name: 'LoRA',
  unet_name: 'UNet',
  control_net_name: 'ControlNet',
  clip_vision_name: 'CLIP Vision',
  style_model_name: 'Style Model',
  upscale_model: '放大模型',
  strength_model: 'LoRA 模型强度',
  strength_clip: 'LoRA CLIP 强度',
  start_at_step: '起始步数',
  end_at_step: '结束步数',
  guidance: 'Guidance',
  shift: 'Shift',
  fps: 'FPS',
  frame_rate: '帧率',
  num_frames: '帧数',
  duration: '时长',
  strength: '强度',
  weight: '权重',
  control_after_generate: 'Seed 生成策略',
  add_noise: '添加噪声',
};

function cleanId(value: unknown, fallback: string): string {
  const raw = String(value ?? '').trim().toLowerCase();
  const cleaned = raw.replace(/[^a-z0-9._:-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned || fallback;
}

function cleanText(value: unknown, fallback = '', max = 160): string {
  const text = String(value ?? '').trim();
  return (text || fallback).slice(0, max);
}

function uniqueById<T extends { id: string }>(items: T[]): T[] {
  const out: T[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (!item?.id || seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}

function sortByOrder<T extends { order?: number; title?: string; name?: string; id: string }>(items: T[]): T[] {
  return items.slice().sort((a, b) => {
    const ao = Number.isFinite(a.order) ? Number(a.order) : 9999;
    const bo = Number.isFinite(b.order) ? Number(b.order) : 9999;
    if (ao !== bo) return ao - bo;
    return String(a.title || a.name || a.id).localeCompare(String(b.title || b.name || b.id), 'zh-Hans-CN');
  });
}

export function normalizeComfyAppManifest(value: Partial<ComfyAppManifest> | null | undefined): ComfyAppManifest {
  const rawCategories = Array.isArray(value?.categories) ? value!.categories : [];
  const categories = uniqueById(rawCategories.map((item: any, index) => ({
    id: cleanId(item?.id, `${DEFAULT_CATEGORY_ID}-${index + 1}`),
    name: cleanText(item?.name, `分类${index + 1}`, 80),
    description: cleanText(item?.description, '', 200),
    icon: cleanText(item?.icon, 'Boxes', 40),
    order: Number.isFinite(item?.order) ? Number(item.order) : index,
  })));
  if (!categories.length) categories.push({ id: DEFAULT_CATEGORY_ID, name: '我的工作流', description: '', icon: 'Boxes', order: 0 });
  const categoryIds = new Set(categories.map((item) => item.id));

  const rawApps = Array.isArray(value?.apps) ? value!.apps : [];
  const apps = uniqueById(rawApps.map((item: any, index): ComfyAppDefinition | null => {
    if (!item || typeof item !== 'object' || !item.workflowJson || typeof item.workflowJson !== 'object' || Array.isArray(item.workflowJson)) return null;
    const id = cleanId(item.id || item.title, `comfy-app-${index + 1}`);
    const categoryId = categoryIds.has(cleanId(item.categoryId, '')) ? cleanId(item.categoryId, '') : categories[0].id;
    const fields = compactComfyFields(item.fields);
    const rawUserParams = Array.isArray(item.userParams) ? item.userParams.map((param: any, paramIndex: number): ComfyAppUserParam | null => {
      const key = cleanId(param?.key || param?.source, `param-${paramIndex + 1}`);
      const source = cleanText(param?.source || key, key, 80);
      if (!source) return null;
      const kind = ['textarea', 'number', 'boolean', 'select'].includes(param?.kind) ? param.kind : 'text';
      const fieldName = cleanText(param?.fieldName, '', 80);
      return {
        key,
        label: cleanText(param?.label, COMFY_APP_SOURCE_LABELS[source] || COMFY_APP_SOURCE_LABELS[fieldName] || source, 80),
        kind,
        source,
        nodeId: cleanText(param?.nodeId, '', 40),
        fieldName,
        nodeTitle: cleanText(param?.nodeTitle, '', 120),
        defaultValue: param?.defaultValue,
        placeholder: cleanText(param?.placeholder, '', 160),
        required: param?.required === true,
        min: Number.isFinite(param?.min) ? Number(param.min) : undefined,
        max: Number.isFinite(param?.max) ? Number(param.max) : undefined,
        step: Number.isFinite(param?.step) ? Number(param.step) : undefined,
        options: Array.isArray(param?.options) ? param.options.slice(0, 120) : undefined,
        rows: Number.isFinite(param?.rows) ? Math.max(2, Math.min(12, Number(param.rows))) : undefined,
      };
    }).filter(Boolean) as ComfyAppUserParam[] : [];
    const stabilized = stabilizeComfyAppRuntimeParams(fields, rawUserParams);
    const outputNodeIds: string[] = Array.isArray(item.outputNodeIds)
      ? [...new Set<string>(item.outputNodeIds.map((nodeId: any) => cleanText(nodeId, '', 40)).filter(Boolean))].slice(0, 80)
      : [];
    const outputs = Array.isArray(item.outputs) && item.outputs.length ? item.outputs : [{ key: 'image', label: '输出图', kind: 'image' }];
    return {
      id,
      title: cleanText(item.title || item.name, id, 100),
      categoryId,
      description: cleanText(item.description, '', 300),
      workflowJson: item.workflowJson,
      ...(outputNodeIds.length ? { outputNodeIds } : {}),
      fields: stabilized.fields,
      userParams: stabilized.userParams,
      outputs: outputs.map((output: any, outputIndex: number) => ({
        key: cleanId(output?.key, `output-${outputIndex + 1}`),
        label: cleanText(output?.label, `输出${outputIndex + 1}`, 80),
        kind: output?.kind === 'video' || output?.kind === 'audio' || output?.kind === 'text' ? output.kind : 'image',
      })),
      capabilities: Array.isArray(item.capabilities) ? item.capabilities.map((cap: any) => cleanText(cap, '', 80)).filter(Boolean) : ['image.generate'],
      runtime: {
        pollIntervalMs: Number(item.runtime?.pollIntervalMs) || 1000,
        maxPolls: Number(item.runtime?.maxPolls) || 3600,
      },
      ui: {
        icon: cleanText(item.ui?.icon, 'Workflow', 40),
        accent: cleanText(item.ui?.accent, '#67e8f9', 40),
      },
      version: Number(item.version) || 1,
      updatedAt: cleanText(item.updatedAt, '', 40),
    };
  }).filter(Boolean) as ComfyAppDefinition[]);

  return {
    schema: 't8-comfyui-app-manifest',
    version: Number(value?.version) || 1,
    updatedAt: cleanText(value?.updatedAt, '', 40),
    categories: sortByOrder(categories),
    apps: sortByOrder(apps),
  };
}

export function fieldDefaultValue(workflowJson: Record<string, any> | undefined, field: ComfyFieldMapping): any {
  if (!workflowJson || !field) return undefined;
  return comfyFieldInputValue(workflowJson, field);
}

function paramKindFor(source: string, value: any, options?: Array<string | number>): ComfyAppParamKind {
  if (options?.length) return 'select';
  if (TEXT_SOURCES.has(source)) return 'textarea';
  if (
    typeof value === 'number'
    || ['width', 'height', 'batch_size', 'seed', 'steps', 'cfg', 'denoise', 'strength_model', 'strength_clip', 'start_at_step', 'end_at_step', 'guidance', 'shift', 'fps', 'frame_rate', 'num_frames', 'duration', 'strength', 'weight'].includes(source)
  ) return 'number';
  if (typeof value === 'boolean') return 'boolean';
  return 'text';
}

function paramKeyFor(field: ComfyFieldMapping): string {
  const source = String(field.source || field.fieldName || '').trim();
  if (source && !MEDIA_SOURCE_RE.test(source) && source !== 'fixed') return cleanId(source, `${field.nodeId}-${field.fieldName}`);
  return cleanId(`${field.nodeId}-${field.fieldName}`, 'param');
}

function shouldExposeParam(field: ComfyFieldMapping): boolean {
  const source = String(field.source || '').trim();
  if (!source || source === 'fixed' || MEDIA_SOURCE_RE.test(source)) return false;
  if (EXPOSED_SOURCES.has(source)) return true;
  return SAFE_CUSTOM_SOURCE_RE.test(source) && !BLOCKED_CUSTOM_SOURCES.has(source.toLowerCase());
}

function shouldScopeDuplicateSource(source: string): boolean {
  return !!source
    && source !== 'fixed'
    && !MEDIA_SOURCE_RE.test(source)
    && !SHARED_DUPLICATE_SOURCES.has(source);
}

function fieldSourceKey(source: string, nodeId?: string, fieldName?: string): string {
  return `${source}::${nodeId || ''}::${fieldName || ''}`;
}

function uniqueCleanId(base: string, fallback: string, used: Set<string>): string {
  const cleanBase = cleanId(base, fallback);
  let candidate = cleanBase;
  let index = 2;
  while (used.has(candidate)) {
    candidate = cleanId(`${cleanBase}-${index}`, fallback);
    index += 1;
  }
  used.add(candidate);
  return candidate;
}

function labelSourceFor(field: ComfyFieldMapping, fallbackSource: string): string {
  const fieldName = String(field.fieldName || '').trim();
  return COMFY_APP_SOURCE_LABELS[fallbackSource] || COMFY_APP_SOURCE_LABELS[fieldName] || fallbackSource || fieldName;
}

function scopeDuplicateComfyFieldSources(fields: ComfyFieldMapping[]): {
  fields: ComfyFieldMapping[];
  sourceLabels: Map<string, string>;
} {
  const counts = new Map<string, number>();
  for (const field of fields) {
    const source = String(field.source || '').trim();
    if (!shouldExposeParam(field) || !shouldScopeDuplicateSource(source)) continue;
    counts.set(source, (counts.get(source) || 0) + 1);
  }

  const usedSources = new Set(fields.map((field) => String(field.source || '').trim()).filter(Boolean));
  const sourceLabels = new Map<string, string>();
  const nextFields = fields.map((field) => {
    const source = String(field.source || '').trim();
    if ((counts.get(source) || 0) <= 1) return field;
    const scopedSource = uniqueCleanId(`${source}-${field.nodeId}-${field.fieldName}`, `${field.nodeId}-${field.fieldName}`, usedSources);
    sourceLabels.set(scopedSource, labelSourceFor(field, source));
    return { ...field, source: scopedSource };
  });

  return { fields: nextFields, sourceLabels };
}

function ensureUniqueComfyParamKeys(params: ComfyAppUserParam[]): ComfyAppUserParam[] {
  const used = new Set<string>();
  return params.map((param, index) => {
    const fallback = `${param.nodeId || 'param'}-${param.fieldName || index + 1}`;
    const key = uniqueCleanId(param.key || param.source, fallback, used);
    return key === param.key ? param : { ...param, key };
  });
}

function dedupeComfyAppUserParams(params: ComfyAppUserParam[]): ComfyAppUserParam[] {
  const out: ComfyAppUserParam[] = [];
  const seenSharedSources = new Set<string>();
  const seenExactParams = new Set<string>();
  for (const param of params) {
    const source = String(param.source || '').trim();
    const exactKey = `${source}::${param.nodeId || ''}::${param.fieldName || ''}`;
    if (seenExactParams.has(exactKey)) continue;
    seenExactParams.add(exactKey);
    if (SHARED_DUPLICATE_SOURCES.has(source)) {
      if (seenSharedSources.has(source)) continue;
      seenSharedSources.add(source);
    }
    out.push(param);
  }
  return ensureUniqueComfyParamKeys(out);
}

function stabilizeComfyAppRuntimeParams(
  fields: ComfyFieldMapping[],
  userParams: ComfyAppUserParam[],
): { fields: ComfyFieldMapping[]; userParams: ComfyAppUserParam[] } {
  const counts = new Map<string, number>();
  for (const param of userParams) {
    const source = String(param.source || '').trim();
    if (!shouldScopeDuplicateSource(source)) continue;
    counts.set(source, (counts.get(source) || 0) + 1);
  }
  if (![...counts.values()].some((count) => count > 1)) {
    return { fields, userParams: dedupeComfyAppUserParams(userParams) };
  }

  const usedSources = new Set(fields.map((field) => String(field.source || '').trim()).filter(Boolean));
  const scopedByField = new Map<string, string>();
  const fieldByScopedSource = new Map<string, ComfyFieldMapping>();
  const scopedFieldsBySource = new Map<string, ComfyFieldMapping[]>();
  const nextFields = fields.map((field) => {
    const source = String(field.source || '').trim();
    if ((counts.get(source) || 0) <= 1) return field;
    const scopedSource = uniqueCleanId(`${source}-${field.nodeId}-${field.fieldName}`, `${field.nodeId}-${field.fieldName}`, usedSources);
    scopedByField.set(fieldSourceKey(source, field.nodeId, field.fieldName), scopedSource);
    const nextField = { ...field, source: scopedSource };
    fieldByScopedSource.set(scopedSource, nextField);
    const bucket = scopedFieldsBySource.get(source) || [];
    bucket.push(nextField);
    scopedFieldsBySource.set(source, bucket);
    return nextField;
  });

  const fallbackIndexBySource = new Map<string, number>();
  const nextParams = userParams.map((param) => {
    const source = String(param.source || '').trim();
    if ((counts.get(source) || 0) <= 1) return param;
    let scopedSource = scopedByField.get(fieldSourceKey(source, param.nodeId, param.fieldName));
    if (!scopedSource) {
      const candidates = scopedFieldsBySource.get(source) || [];
      const index = fallbackIndexBySource.get(source) || 0;
      scopedSource = candidates[index]?.source || candidates[candidates.length - 1]?.source;
      fallbackIndexBySource.set(source, index + 1);
    }
    if (!scopedSource) return param;
    const scopedField = fieldByScopedSource.get(scopedSource);
    return {
      ...param,
      source: scopedSource,
      key: scopedSource,
      nodeId: param.nodeId || scopedField?.nodeId,
      fieldName: param.fieldName || scopedField?.fieldName,
      nodeTitle: param.nodeTitle || (scopedField as any)?.nodeTitle,
    };
  });

  return { fields: nextFields, userParams: dedupeComfyAppUserParams(nextParams) };
}

export function buildComfyAppFromWorkflow(options: {
  workflowJson: Record<string, any>;
  title?: string;
  id?: string;
  categoryId?: string;
  description?: string;
  excludeRules?: string[];
  outputNodeIds?: string[];
}): ComfyAppDefinition {
  const title = cleanText(options.title, 'ComfyUI 工作流', 100);
  const analysis = analyzeComfyWorkflow(options.workflowJson);
  const baseFields = compactComfyFields(filterComfyFieldsByExcludeRules(options.workflowJson, analysis.fields, options.excludeRules));
  const scoped = scopeDuplicateComfyFieldSources(baseFields);
  const fields = scoped.fields;
  const userParams = dedupeComfyAppUserParams(fields
    .filter(shouldExposeParam)
    .map((field) => {
      const source = String(field.source || field.fieldName || '').trim();
      const behaviorSource = COMFY_APP_SOURCE_LABELS[source] ? source : String(field.fieldName || source).trim();
      const displayLabel = scoped.sourceLabels.get(source) || labelSourceFor(field, source);
      const value = fieldDefaultValue(options.workflowJson, field);
      const fieldOptions = comfyFieldOptionsForWorkflow(options.workflowJson, field);
      const kind = paramKindFor(behaviorSource, value, fieldOptions);
      return {
        key: paramKeyFor(field),
        label: field.nodeId ? `${displayLabel} #${field.nodeId}` : displayLabel,
        kind,
        source,
        nodeId: field.nodeId,
        fieldName: field.fieldName,
        nodeTitle: (field as any).nodeTitle,
        defaultValue: value,
        required: behaviorSource === 'prompt',
        min: ['width', 'height'].includes(behaviorSource) ? 64 : behaviorSource === 'batch_size' ? 1 : undefined,
        max: ['width', 'height'].includes(behaviorSource) ? 8192 : behaviorSource === 'batch_size' ? 16 : undefined,
        step: ['width', 'height'].includes(behaviorSource) ? 8 : ['cfg', 'denoise', 'guidance', 'shift', 'strength', 'weight'].includes(behaviorSource) || behaviorSource.startsWith('strength_') ? 0.1 : 1,
        options: fieldOptions.length ? fieldOptions : undefined,
        rows: TEXT_SOURCES.has(behaviorSource) ? (behaviorSource === 'negative' ? 4 : 5) : undefined,
      } as ComfyAppUserParam;
    }));

  return {
    id: cleanId(options.id || title, `comfy-${Date.now().toString(36)}`),
    title,
    categoryId: cleanId(options.categoryId, DEFAULT_CATEGORY_ID),
    description: cleanText(options.description, '从 ComfyUI API Workflow 自动生成的应用', 300),
    workflowJson: options.workflowJson,
    ...(Array.isArray(options.outputNodeIds) && options.outputNodeIds.length
      ? { outputNodeIds: [...new Set(options.outputNodeIds.map((nodeId) => cleanText(nodeId, '', 40)).filter(Boolean))].slice(0, 80) }
      : {}),
    fields,
    userParams,
    outputs: [{ key: 'image', label: '输出图', kind: 'image' }],
    capabilities: ['image.generate'],
    runtime: { pollIntervalMs: 1000, maxPolls: 3600 },
    ui: { icon: 'Workflow', accent: '#67e8f9' },
    version: 1,
    updatedAt: new Date().toISOString(),
  };
}

export function comfyAppInputRequirements(app: ComfyAppDefinition | null | undefined): ComfyAppInputRequirements {
  const req = { images: 0, videos: 0, audios: 0 };
  for (const field of Array.isArray(app?.fields) ? app!.fields : []) {
    const source = String(field.source || '').trim().toLowerCase();
    const match = source.match(/^(image|video|audio)(?:_|-)?(\d+)$/);
    if (!match) continue;
    const n = Math.max(1, Number(match[2]) || 1);
    if (match[1] === 'image') req.images = Math.max(req.images, n);
    if (match[1] === 'video') req.videos = Math.max(req.videos, n);
    if (match[1] === 'audio') req.audios = Math.max(req.audios, n);
  }
  return req;
}

export function defaultComfyAppParamValues(app: ComfyAppDefinition | null | undefined): Record<string, any> {
  const values: Record<string, any> = {};
  for (const param of Array.isArray(app?.userParams) ? app!.userParams : []) {
    values[param.key] = param.defaultValue ?? (param.kind === 'boolean' ? false : '');
  }
  return values;
}

export function paramsToProviderParams(app: ComfyAppDefinition, values: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const param of app.userParams || []) {
    const value = Object.prototype.hasOwnProperty.call(values, param.key) ? values[param.key] : param.defaultValue;
    if (value === undefined || value === null || value === '') continue;
    out[param.source] = param.kind === 'number' ? Number(value) : value;
  }
  return out;
}

export function promptFromComfyParams(app: ComfyAppDefinition, values: Record<string, any>, upstreamTexts: string[] = []): string {
  const promptParam = app.userParams.find((param) => param.source === 'prompt');
  const prompt = promptParam ? String(values[promptParam.key] ?? promptParam.defaultValue ?? '').trim() : '';
  return (upstreamTexts.join('\n').trim() || prompt).trim();
}

export function negativeFromComfyParams(app: ComfyAppDefinition, values: Record<string, any>): string {
  const param = app.userParams.find((item) => item.source === 'negative');
  return param ? String(values[param.key] ?? param.defaultValue ?? '').trim() : '';
}

export function sizeFromComfyParams(app: ComfyAppDefinition, values: Record<string, any>, fallback = '1024x1024'): string {
  const widthParam = app.userParams.find((param) => param.source === 'width');
  const heightParam = app.userParams.find((param) => param.source === 'height');
  const width = Number(widthParam ? values[widthParam.key] ?? widthParam.defaultValue : 0);
  const height = Number(heightParam ? values[heightParam.key] ?? heightParam.defaultValue : 0);
  if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
    return `${Math.round(width)}x${Math.round(height)}`;
  }
  return fallback;
}

export function getComfyProviderBaseUrl(provider: AdvancedProviderConfig | null | undefined): string {
  return String(provider?.baseUrl || provider?.comfyuiConfig?.instances?.[0] || 'http://127.0.0.1:8188').trim();
}

export function getUserComfyAppManifest(): ComfyAppManifest {
  if (typeof window === 'undefined') return normalizeComfyAppManifest(null);
  try {
    return normalizeComfyAppManifest(JSON.parse(window.localStorage.getItem(STORAGE_KEY) || '{}'));
  } catch {
    return normalizeComfyAppManifest(null);
  }
}

export function saveUserComfyAppManifest(manifest: ComfyAppManifest) {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(normalizeComfyAppManifest(manifest)));
  window.dispatchEvent(new CustomEvent(COMFY_APP_MANIFEST_EVENT));
}

export function saveComfyAppCategory(
  category: Partial<ComfyAppCategory>,
  baseManifest?: ComfyAppManifest,
): ComfyAppManifest {
  const current = normalizeComfyAppManifest(baseManifest || getUserComfyAppManifest());
  const id = cleanId(category.id || category.name, `category-${current.categories.length + 1}`);
  const existing = current.categories.find((item) => item.id === id);
  const nextCategory: ComfyAppCategory = {
    id,
    name: cleanText(category.name, existing?.name || id, 80),
    description: cleanText(category.description, existing?.description || '', 200),
    icon: cleanText(category.icon, existing?.icon || 'Boxes', 40),
    order: Number.isFinite(category.order) ? Number(category.order) : (existing?.order ?? current.categories.length),
  };
  const next = normalizeComfyAppManifest({
    ...current,
    updatedAt: new Date().toISOString(),
    categories: [
      ...current.categories.filter((item) => item.id !== id),
      nextCategory,
    ],
  });
  saveUserComfyAppManifest(next);
  return next;
}

export function deleteComfyAppCategory(
  categoryId: string,
  fallbackCategoryId = DEFAULT_CATEGORY_ID,
  baseManifest?: ComfyAppManifest,
): ComfyAppManifest {
  const current = normalizeComfyAppManifest(baseManifest || getUserComfyAppManifest());
  const targetId = cleanId(categoryId, '');
  if (!targetId) return current;
  const remainingCategories = current.categories.filter((category) => category.id !== targetId);
  const fallback = remainingCategories.find((category) => category.id === fallbackCategoryId) || remainingCategories[0] || {
    id: DEFAULT_CATEGORY_ID,
    name: '我的工作流',
    icon: 'Boxes',
    order: 0,
  };
  const next = normalizeComfyAppManifest({
    ...current,
    updatedAt: new Date().toISOString(),
    categories: remainingCategories.length ? remainingCategories : [fallback],
    apps: current.apps.map((app) => (
      app.categoryId === targetId ? { ...app, categoryId: fallback.id, updatedAt: new Date().toISOString() } : app
    )),
  });
  saveUserComfyAppManifest(next);
  return next;
}

export function saveComfyApp(app: ComfyAppDefinition, baseManifest?: ComfyAppManifest): ComfyAppManifest {
  const current = normalizeComfyAppManifest(baseManifest || getUserComfyAppManifest());
  const normalizedApp = normalizeComfyAppManifest({
    ...current,
    apps: [app],
    categories: current.categories,
  }).apps[0];
  const categoryExists = current.categories.some((category) => category.id === normalizedApp.categoryId);
  const categories = categoryExists
    ? current.categories
    : [...current.categories, { id: normalizedApp.categoryId, name: normalizedApp.categoryId, icon: 'Boxes', order: current.categories.length }];
  const apps = [
    ...current.apps.filter((item) => item.id !== normalizedApp.id),
    normalizedApp,
  ];
  const next = normalizeComfyAppManifest({
    schema: 't8-comfyui-app-manifest',
    version: 1,
    updatedAt: new Date().toISOString(),
    categories,
    apps,
  });
  saveUserComfyAppManifest(next);
  return next;
}

export function deleteComfyApp(appId: string, baseManifest?: ComfyAppManifest): ComfyAppManifest {
  const current = normalizeComfyAppManifest(baseManifest || getUserComfyAppManifest());
  const id = cleanId(appId, '');
  if (!id) return current;
  const next = normalizeComfyAppManifest({
    ...current,
    updatedAt: new Date().toISOString(),
    apps: current.apps.filter((app) => app.id !== id),
  });
  saveUserComfyAppManifest(next);
  return next;
}

export function moveComfyAppToCategory(
  appId: string,
  categoryId: string,
  baseManifest?: ComfyAppManifest,
): ComfyAppManifest {
  const current = normalizeComfyAppManifest(baseManifest || getUserComfyAppManifest());
  const id = cleanId(appId, '');
  const nextCategoryId = cleanId(categoryId, current.categories[0]?.id || DEFAULT_CATEGORY_ID);
  const categoryExists = current.categories.some((category) => category.id === nextCategoryId);
  const categories = categoryExists
    ? current.categories
    : [...current.categories, { id: nextCategoryId, name: nextCategoryId, icon: 'Boxes', order: current.categories.length }];
  const apps = current.apps.map((app) => (
    app.id === id ? { ...app, categoryId: nextCategoryId, updatedAt: new Date().toISOString() } : app
  ));
  const next = normalizeComfyAppManifest({
    ...current,
    updatedAt: new Date().toISOString(),
    categories,
    apps,
  });
  saveUserComfyAppManifest(next);
  return next;
}

export function mergeComfyAppManifests(...manifests: Array<Partial<ComfyAppManifest> | null | undefined>): ComfyAppManifest {
  const categories: ComfyAppCategory[] = [];
  const appMap = new Map<string, ComfyAppDefinition>();
  for (const manifest of manifests) {
    const normalized = normalizeComfyAppManifest(manifest);
    categories.push(...normalized.categories);
    for (const app of normalized.apps) appMap.set(app.id, app);
  }
  return normalizeComfyAppManifest({
    schema: 't8-comfyui-app-manifest',
    version: 1,
    categories,
    apps: Array.from(appMap.values()),
  });
}

export function importComfyAppPayload(payload: unknown): ComfyAppManifest {
  if (payload && typeof payload === 'object' && !Array.isArray(payload) && (payload as any).schema === 't8-comfyui-app-manifest') {
    return normalizeComfyAppManifest(payload as ComfyAppManifest);
  }
  if (payload && typeof payload === 'object' && !Array.isArray(payload) && (payload as any).workflowJson) {
    const app = normalizeComfyAppManifest({ apps: [payload as any] }).apps[0];
    return normalizeComfyAppManifest({ apps: app ? [app] : [] });
  }
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    return normalizeComfyAppManifest({ apps: [buildComfyAppFromWorkflow({ workflowJson: payload as Record<string, any> })] });
  }
  return normalizeComfyAppManifest(null);
}

export function importComfyAppManifest(
  payload: unknown,
  baseManifest?: ComfyAppManifest,
): ComfyAppManifest {
  const current = normalizeComfyAppManifest(baseManifest || getUserComfyAppManifest());
  const imported = importComfyAppPayload(payload);
  const appIds = new Set(imported.apps.map((app) => app.id));
  const next = normalizeComfyAppManifest({
    schema: 't8-comfyui-app-manifest',
    version: Math.max(Number(current.version) || 1, Number(imported.version) || 1),
    updatedAt: new Date().toISOString(),
    categories: [...current.categories, ...imported.categories],
    apps: [
      ...current.apps.filter((app) => !appIds.has(app.id)),
      ...imported.apps,
    ],
  });
  saveUserComfyAppManifest(next);
  return next;
}

export function filterComfyApps(
  manifest: ComfyAppManifest,
  options: { categoryId?: string; query?: string } = {},
): ComfyAppDefinition[] {
  const query = String(options.query || '').trim().toLowerCase();
  return manifest.apps.filter((app) => {
    if (options.categoryId && options.categoryId !== COMFY_APP_ALL_CATEGORY_ID && app.categoryId !== options.categoryId) return false;
    if (!query) return true;
    return `${app.title} ${app.description || ''} ${(app.capabilities || []).join(' ')}`.toLowerCase().includes(query);
  });
}
