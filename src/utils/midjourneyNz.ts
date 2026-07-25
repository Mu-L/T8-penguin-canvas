import type {
  MidjourneyNzOperation,
  MidjourneyNzSubmitRequest,
} from '../services/generation';

export const MIDJOURNEY_NZ_ACTIONS: Array<{
  value: MidjourneyNzOperation;
  label: string;
  result: 'image' | 'video' | 'text' | 'modal';
  summary: string;
}> = [
  { value: 'midjourney-imagine', label: 'Imagine · 生成图片', result: 'image', summary: 'Prompt 必填，可选 0–4 张参考图。' },
  { value: 'midjourney-blend', label: 'Blend · 融合图片', result: 'image', summary: '必须提供 2–4 张参考图，不使用 Prompt。' },
  { value: 'midjourney-describe', label: 'Describe · 反推描述', result: 'text', summary: '必须且只能提供 1 张参考图，返回文字描述。' },
  { value: 'midjourney-edits', label: 'Edits · 图片编辑', result: 'image', summary: 'Prompt 必填，必须提供 1–4 张参考图。' },
  { value: 'midjourney-upscale', label: 'Upscale · 放大子图', result: 'image', summary: '使用历史任务 ID 和 1–4 子图索引，或使用 custom_id。' },
  { value: 'midjourney-variation', label: 'Variation · 生成变体', result: 'image', summary: '使用历史任务 ID 和 1–4 子图索引，或使用 custom_id。' },
  { value: 'midjourney-high-variation', label: 'High Variation · 高变化', result: 'image', summary: '使用历史任务 ID 和 1–4 子图索引，或使用 custom_id。' },
  { value: 'midjourney-low-variation', label: 'Low Variation · 低变化', result: 'image', summary: '使用历史任务 ID 和 1–4 子图索引，或使用 custom_id。' },
  { value: 'midjourney-reroll', label: 'Reroll · 重新生成', result: 'image', summary: '使用历史任务 ID 重新生成，可选 custom_id。' },
  { value: 'midjourney-zoom', label: 'Zoom · 扩图', result: 'image', summary: '使用历史任务 ID；缩放倍率为 1.0–2.0。' },
  { value: 'midjourney-pan', label: 'Pan · 方向扩图', result: 'image', summary: '使用历史任务 ID，并选择左/右/上/下方向。' },
  { value: 'midjourney-inpaint', label: 'Inpaint · 进入局部重绘', result: 'modal', summary: '先将历史任务切换到 MODAL，随后填写遮罩并执行 Modal。' },
  { value: 'midjourney-modal', label: 'Modal · 提交局部重绘', result: 'image', summary: '局部重绘使用第 1 张参考图作为 PNG 遮罩；扩图不需要遮罩。' },
  { value: 'midjourney-remix-strong', label: 'Remix Strong · 强重混', result: 'image', summary: '仅适用于 v8.1/v8.2 来源任务，任务 ID、1–4 索引必填。' },
  { value: 'midjourney-remix-subtle', label: 'Remix Subtle · 轻重混', result: 'image', summary: '仅适用于 v8.1/v8.2 来源任务，任务 ID、1–4 索引必填。' },
  { value: 'midjourney-video', label: 'Video · 图片转视频', result: 'video', summary: '可使用 1 张首帧或历史任务；任务索引为 0–3。' },
];

export const MIDJOURNEY_NZ_TASK_ACTIONS = new Set<MidjourneyNzOperation>([
  'midjourney-upscale',
  'midjourney-variation',
  'midjourney-high-variation',
  'midjourney-low-variation',
  'midjourney-reroll',
  'midjourney-zoom',
  'midjourney-pan',
  'midjourney-inpaint',
  'midjourney-modal',
  'midjourney-remix-strong',
  'midjourney-remix-subtle',
]);

export const MIDJOURNEY_NZ_ONE_BASED_INDEX_ACTIONS = new Set<MidjourneyNzOperation>([
  'midjourney-upscale',
  'midjourney-variation',
  'midjourney-high-variation',
  'midjourney-low-variation',
  'midjourney-remix-strong',
  'midjourney-remix-subtle',
]);

export const MIDJOURNEY_NZ_OPTIONAL_INDEX_ACTIONS = new Set<MidjourneyNzOperation>([
  'midjourney-zoom',
  'midjourney-pan',
  'midjourney-inpaint',
]);

export const MIDJOURNEY_NZ_CUSTOM_ID_ACTIONS = new Set<MidjourneyNzOperation>([
  'midjourney-upscale',
  'midjourney-variation',
  'midjourney-high-variation',
  'midjourney-low-variation',
  'midjourney-reroll',
  'midjourney-zoom',
  'midjourney-pan',
  'midjourney-inpaint',
]);

export function midjourneyNzRequiresPrompt(
  operation: MidjourneyNzOperation,
  videoSource: 'image' | 'task' = 'image',
): boolean {
  if (operation === 'midjourney-imagine' || operation === 'midjourney-edits') return true;
  if (operation === 'midjourney-video') return videoSource === 'image';
  return false;
}
function finiteNumber(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function optionalText(value: unknown): string | undefined {
  const text = String(value ?? '').trim();
  return text || undefined;
}

export function buildMidjourneyNzRequest(
  data: any,
  prompt: string,
  images: string[],
): MidjourneyNzSubmitRequest {
  const operation = (data?.mjNzOperation || 'midjourney-imagine') as MidjourneyNzOperation;
  const videoSource: 'image' | 'task' = data?.mjNzVideoSource === 'task' ? 'task' : 'image';
  const sourceTaskId = String(data?.mjNzSourceTaskId || data?.mjNzLastTaskId || data?.taskId || '').trim();
  const customId = String(data?.mjNzCustomId || '').trim();
  const request: MidjourneyNzSubmitRequest = {
    operation,
    speed: (data?.mjNzSpeed || 'fast') as MidjourneyNzSubmitRequest['speed'],
  };

  if (operation === 'midjourney-imagine') {
    request.prompt = prompt;
    request.images = images.slice(0, 4);
  } else if (operation === 'midjourney-blend') {
    request.images = images.slice(0, 4);
    request.dimensions = (data?.mjNzDimensions || 'SQUARE') as MidjourneyNzSubmitRequest['dimensions'];
    request.size = optionalText(data?.mjNzBlendSize);
  } else if (operation === 'midjourney-describe') {
    request.images = images.slice(0, 1);
  } else if (operation === 'midjourney-edits') {
    request.prompt = prompt;
    request.images = images.slice(0, 4);
  } else if (operation === 'midjourney-video') {
    request.prompt = optionalText(prompt);
    request.video_type = (data?.mjNzVideoType || 'vid_1.1_i2v_480') as MidjourneyNzSubmitRequest['video_type'];
    request.animate_mode = (data?.mjNzAnimateMode || 'manual') as MidjourneyNzSubmitRequest['animate_mode'];
    request.motion = (data?.mjNzMotion || 'low') as MidjourneyNzSubmitRequest['motion'];
    request.batch_size = ([1, 2, 4].includes(Number(data?.mjNzBatchSize))
      ? Number(data.mjNzBatchSize)
      : 1) as 1 | 2 | 4;
    if (videoSource === 'task') {
      request.task_id = sourceTaskId;
      request.index = Math.max(0, Math.min(3, Math.trunc(finiteNumber(data?.mjNzVideoIndex, 0))));
    } else {
      request.images = images.slice(0, 1);
      if (String(request.video_type).includes('_start_end_')) request.end_url = images[1];
    }
  } else {
    request.task_id = sourceTaskId;
    if (MIDJOURNEY_NZ_CUSTOM_ID_ACTIONS.has(operation) && customId) {
      request.custom_id = customId;
    } else if (
      MIDJOURNEY_NZ_ONE_BASED_INDEX_ACTIONS.has(operation)
      || MIDJOURNEY_NZ_OPTIONAL_INDEX_ACTIONS.has(operation)
    ) {
      request.index = Math.max(1, Math.min(4, Math.trunc(finiteNumber(data?.mjNzIndex, 1))));
    }
    if (operation === 'midjourney-pan' && !customId) {
      request.direction = (data?.mjNzDirection || 'left') as MidjourneyNzSubmitRequest['direction'];
    }
    if (operation === 'midjourney-zoom' && !customId) {
      request.zoom_ratio = Math.max(1, Math.min(2, finiteNumber(data?.mjNzZoomRatio, 2)));
    }
    if (operation === 'midjourney-modal') {
      request.prompt = optionalText(prompt);
      request.modal_mode = data?.mjNzModalMode === 'outpaint' ? 'outpaint' : 'region';
      if (request.modal_mode === 'region') request.mask_url = images[0];
    }
    if (operation === 'midjourney-remix-strong' || operation === 'midjourney-remix-subtle') {
      request.prompt = optionalText(prompt);
    }
  }

  if (operation === 'midjourney-imagine' || operation === 'midjourney-edits') {
    const version = String(data?.mjNzVersion || '').trim();
    const quality = String(data?.mjNzQuality || '').trim();
    if (version && version !== 'unset') request.version = version as MidjourneyNzSubmitRequest['version'];
    if (quality && quality !== 'unset') request.quality = quality as MidjourneyNzSubmitRequest['quality'];
    request.style = optionalText(data?.mjNzStyle);
    request.negative_prompt = optionalText(data?.mjNzNegativePrompt);
    const seed = Math.trunc(finiteNumber(data?.mjNzSeed, -1));
    if (seed >= 0) request.seed = seed;
    for (const [key, field] of [
      ['stylize', 'mjNzStylize'],
      ['chaos', 'mjNzChaos'],
      ['weird', 'mjNzWeird'],
      ['cw', 'mjNzCw'],
      ['sw', 'mjNzSw'],
      ['repeat', 'mjNzRepeat'],
      ['stop', 'mjNzStop'],
    ] as const) {
      const value = Math.trunc(finiteNumber(data?.[field], key === 'repeat' || key === 'stop' ? 0 : -1));
      if (value > (key === 'repeat' || key === 'stop' ? 0 : -1)) (request as any)[key] = value;
    }
    for (const [key, field] of [['iw', 'mjNzIw'], ['dw', 'mjNzDw']] as const) {
      const value = finiteNumber(data?.[field], -1);
      if (value >= 0) (request as any)[key] = value;
    }
    request.tile = data?.mjNzTile === true || undefined;
    request.niji = data?.mjNzNiji === true || undefined;
    request.raw = data?.mjNzRaw === true || undefined;
    request.draft = data?.mjNzDraft === true || undefined;
    request.hd = data?.mjNzHd === true || undefined;
    request.cref = optionalText(data?.mjNzCref);
    request.sref = optionalText(data?.mjNzSref);
    request.dref = optionalText(data?.mjNzDref);
    request.extra = optionalText(data?.mjNzExtra);
  }
  return request;
}
