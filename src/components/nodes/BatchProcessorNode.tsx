import { memo, useMemo, useRef, useState, type ChangeEvent, type DragEvent, type ReactNode } from 'react';
import { Handle, Position, useEdges, useNodes, useReactFlow, type NodeProps } from '@xyflow/react';
import {
  AlertCircle,
  CheckCircle2,
  Files,
  FolderOpen,
  Image as ImageIcon,
  Loader2,
  Maximize2,
  Play,
  RotateCcw,
  Scissors,
  Sparkles,
  Upload,
  Wand2,
  X,
  ZoomIn,
} from 'lucide-react';
import { PORT_COLOR } from '../../config/portTypes';
import {
  copyFileToOutput,
  openOutputFolder,
  opConvert,
  opPadCanvas,
  opTrimBorder,
} from '../../services/imageOps';
import { runRhImageCapability } from '../../services/rhToolboxCapabilities';
import { useRunTrigger } from '../../hooks/useRunTrigger';
import { createCanvasNodeRunRequestId, requestCanvasNodeRun } from '../../utils/canvasRunRequest';
import { formatMediaSize, getMediaItemsFromData, type MediaItem, type MediaKind } from '../../utils/mediaCollection';
import {
  buildBatchOutputName,
  classifyBatchFile,
  createExclusiveBatchProcessorOperationPatch,
  createBatchItemFromUpload,
  normalizeBatchConcurrency,
  normalizeBatchRetrySettings,
  resolveBatchProcessorOperation,
  runBatchWorkPool,
  summarizeBatchProgress,
  type BatchNamingSettings,
  type BatchProcessorItem,
  type BatchProcessorOperation,
} from '../../utils/batchProcessor';
import { RH_IMAGE_CAPABILITY_PRESETS } from '../../utils/rhToolboxCapabilities';
import { useUpdateNodeData } from './useUpdateNodeData';

const KIND_LABEL: Record<MediaKind, string> = {
  image: '图像',
  video: '视频',
  audio: '音频',
  model3d: '3D',
};

const RATIO_OPTIONS = [
  { value: 'keep', label: '原比例' },
  { value: '1:1', label: '1:1' },
  { value: '4:3', label: '4:3' },
  { value: '16:9', label: '16:9' },
  { value: '9:16', label: '9:16' },
];

const EXPAND_PRESET_OPTIONS = RH_IMAGE_CAPABILITY_PRESETS.expand.paramPresets || [];

type TrimBorderMode = 'auto' | 'black' | 'white' | 'transparent';
type TrimBorderAxis = 'vertical' | 'horizontal' | 'all';
type TrimBorderStrategy = 'auto' | 'manual';

const TRIM_MODE_OPTIONS: Array<{ value: TrimBorderMode; label: string }> = [
  { value: 'auto', label: '自动检测' },
  { value: 'black', label: '黑边' },
  { value: 'white', label: '白边' },
  { value: 'transparent', label: '透明边' },
];

const TRIM_AXIS_OPTIONS: Array<{ value: TrimBorderAxis; label: string }> = [
  { value: 'vertical', label: '仅上下' },
  { value: 'horizontal', label: '仅左右' },
  { value: 'all', label: '上下左右' },
];

const trimModeLabel = (mode: TrimBorderMode) => TRIM_MODE_OPTIONS.find((item) => item.value === mode)?.label || '自动检测';
type BatchProcessorRunMode = 'all' | 'retry-failed';

function batchStatusMeta(status: BatchProcessorItem['status']) {
  if (status === 'running') return { label: '正在处理', color: '#f59e0b', glow: 'rgba(245, 158, 11, 0.32)' };
  if (status === 'success') return { label: '已完成', color: '#22c55e', glow: 'rgba(34, 197, 94, 0.22)' };
  if (status === 'error') return { label: '失败', color: '#ef4444', glow: 'rgba(239, 68, 68, 0.22)' };
  if (status === 'skipped') return { label: '已跳过', color: '#94a3b8', glow: 'rgba(148, 163, 184, 0.18)' };
  return { label: '等待中', color: 'var(--t8-text-dim)', glow: 'transparent' };
}

function dedupeItems(items: BatchProcessorItem[]): BatchProcessorItem[] {
  const seen = new Set<string>();
  const out: BatchProcessorItem[] = [];
  for (const item of items) {
    const key = `${item.kind}:${item.url}`;
    if (!item.url || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function inferAcceptKind(file: File): MediaKind | null {
  return classifyBatchFile(file.name, file.type);
}

function collectUpstreamBatchItems(id: string, edges: any[], nodes: any[]): BatchProcessorItem[] {
  const upstreamIds = edges.filter((edge) => edge.target === id).map((edge) => edge.source);
  const out: BatchProcessorItem[] = [];
  for (const sourceId of upstreamIds) {
    const source = nodes.find((node) => node.id === sourceId);
    const data = (source?.data || {}) as any;
    (['image', 'video', 'audio', 'model3d'] as MediaKind[]).forEach((kind) => {
      getMediaItemsFromData(data, kind).forEach((item, index) => {
        out.push({
          id: `upstream-${sourceId}-${kind}-${index}`,
          kind,
          url: item.url,
          name: item.name || `${KIND_LABEL[kind]} ${index + 1}`,
          size: item.size,
          mime: item.mime,
          status: 'pending',
        });
      });
    });
  }
  return out;
}

function batchItemKey(item: BatchProcessorItem): string {
  return `${item.kind}:${item.url}`;
}

function resetBatchItem(item: BatchProcessorItem): BatchProcessorItem {
  return {
    ...item,
    status: 'pending',
    error: '',
    resultUrl: '',
    outputName: '',
    stepsDone: [],
    trimInfo: undefined,
  };
}

async function uploadBatchFile(file: File, index: number): Promise<BatchProcessorItem | null> {
  const kind = inferAcceptKind(file);
  if (!kind) return null;
  const fd = new FormData();
  fd.append('file', file);
  const response = await fetch('/api/files/upload', { method: 'POST', body: fd });
  const json = await response.json().catch(() => null);
  if (!response.ok || !json?.success || !json.data?.url) {
    throw new Error(json?.error || `上传失败 HTTP ${response.status}`);
  }
  const relativePath = String((file as any).webkitRelativePath || file.name || '').replace(/\\/g, '/');
  return createBatchItemFromUpload({
    kind,
    url: json.data.url,
    name: file.name,
    relativePath,
    size: json.data.size || file.size,
    mime: json.data.mime || file.type,
    index,
  });
}

function FieldLabel({ children }: { children: ReactNode }) {
  return <label className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: 'var(--t8-text-muted)' }}>{children}</label>;
}

function ToggleStep({
  icon,
  label,
  active,
  disabled,
  onChange,
}: {
  icon: ReactNode;
  label: string;
  active: boolean;
  disabled?: boolean;
  onChange: (value: boolean) => void;
}) {
  const stateLabel = active ? '已启用' : '未启用';
  return (
    <button
      type="button"
      className="nodrag nopan t8-btn min-h-[44px] min-w-0 justify-start px-2 py-1.5 text-[11px]"
      disabled={disabled}
      onClick={() => onChange(!active)}
      onMouseDown={(event) => event.stopPropagation()}
      aria-pressed={active}
      title={`${label} · ${stateLabel}`}
      style={{
        borderColor: active ? '#22c55e' : 'var(--t8-border)',
        background: active
          ? 'linear-gradient(135deg, rgba(34,197,94,.22), rgba(20,184,166,.12))'
          : 'var(--t8-bg-soft)',
        color: active ? 'var(--t8-text-main)' : 'var(--t8-text-muted)',
        boxShadow: active ? 'inset 0 0 0 1px rgba(34,197,94,.55)' : undefined,
      }}
    >
      <span className="shrink-0">{icon}</span>
      <span className="min-w-0 flex-1 truncate text-left">{label}</span>
      <span
        className="shrink-0 rounded px-1.5 py-0.5 text-[9px] font-bold"
        style={{
          background: active ? 'rgba(34,197,94,.22)' : 'rgba(148,163,184,.12)',
          color: active ? '#86efac' : 'var(--t8-text-dim)',
        }}
      >
        {stateLabel}
      </span>
    </button>
  );
}

function BatchProcessorNode({ id, data, selected }: NodeProps) {
  const rf = useReactFlow();
  const update = useUpdateNodeData(id);
  const edges = useEdges();
  const nodes = useNodes();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const cancelRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [folderBusy, setFolderBusy] = useState(false);
  const [localError, setLocalError] = useState('');

  const d = (data || {}) as any;
  const storedItems = Array.isArray(d.batchProcessorItems) ? d.batchProcessorItems as BatchProcessorItem[] : [];
  const upstreamItems = useMemo(() => collectUpstreamBatchItems(id, edges, nodes), [id, edges, nodes]);
  const allItems = useMemo(() => dedupeItems([...storedItems, ...upstreamItems]), [storedItems, upstreamItems]);
  const progress = summarizeBatchProgress(allItems);
  const status = d.status || progress.status;
  const running = status === 'running';

  const nameMode: BatchNamingSettings['mode'] = d.batchProcessorNameMode === 'rename' ? 'rename' : 'original';
  const renamePattern = typeof d.batchProcessorRenamePattern === 'string' && d.batchProcessorRenamePattern
    ? d.batchProcessorRenamePattern
    : 'batch-{index}-{name}';
  const outputFormat: BatchNamingSettings['outputFormat'] =
    ['keep', 'png', 'jpg', 'webp'].includes(d.batchProcessorOutputFormat)
      ? d.batchProcessorOutputFormat
      : 'keep';
  const cutoutOutputRatio = RATIO_OPTIONS.some((item) => item.value === d.batchProcessorCutoutOutputRatio)
    ? String(d.batchProcessorCutoutOutputRatio)
    : 'keep';
  const expandPresetId = EXPAND_PRESET_OPTIONS.some((item) => item.id === d.batchProcessorExpandPresetId)
    ? String(d.batchProcessorExpandPresetId)
    : RH_IMAGE_CAPABILITY_PRESETS.expand.defaultParamPresetId;
  const expandPreset = EXPAND_PRESET_OPTIONS.find((item) => item.id === expandPresetId)
    || EXPAND_PRESET_OPTIONS.find((item) => item.id === RH_IMAGE_CAPABILITY_PRESETS.expand.defaultParamPresetId)
    || EXPAND_PRESET_OPTIONS[0];
  const localConcurrency = normalizeBatchConcurrency(d.batchProcessorLocalConcurrency, 4, 1, 8);
  const rhConcurrency = normalizeBatchConcurrency(d.batchProcessorRhConcurrency, 2, 1, 10);
  const { retryCount, continueOnError } = normalizeBatchRetrySettings({
    retryCount: d.batchProcessorRetryCount,
    continueOnError: d.batchProcessorContinueOnError,
  });
  const selectedOperation = resolveBatchProcessorOperation(d);
  const trimSelected = selectedOperation === 'trim';
  const cutoutSelected = selectedOperation === 'cutout';
  const expandSelected = selectedOperation === 'expand';
  const upscaleSelected = selectedOperation === 'upscale';
  const hasRhSteps = cutoutSelected || expandSelected || upscaleSelected;
  const activeConcurrency = hasRhSteps ? rhConcurrency : localConcurrency;
  const trimMode: TrimBorderMode = ['auto', 'black', 'white', 'transparent'].includes(d.batchProcessorTrimMode)
    ? d.batchProcessorTrimMode
    : 'auto';
  const trimAxis: TrimBorderAxis = ['vertical', 'horizontal', 'all'].includes(d.batchProcessorTrimAxis)
    ? d.batchProcessorTrimAxis
    : 'vertical';
  const trimStrategy: TrimBorderStrategy = d.batchProcessorTrimStrategy === 'manual' ? 'manual' : 'auto';
  const trimThreshold = Math.max(0, Math.min(120, Number(d.batchProcessorTrimThreshold ?? 18)));
  const trimManual = {
    top: Math.max(0, Math.min(9999, Number(d.batchProcessorTrimManualTop || 0))),
    right: Math.max(0, Math.min(9999, Number(d.batchProcessorTrimManualRight || 0))),
    bottom: Math.max(0, Math.min(9999, Number(d.batchProcessorTrimManualBottom || 0))),
    left: Math.max(0, Math.min(9999, Number(d.batchProcessorTrimManualLeft || 0))),
  };

  const namingSettingsFor = (item: BatchProcessorItem): BatchNamingSettings => ({
    mode: nameMode,
    pattern: renamePattern,
    sequenceStart: Math.max(1, Number(d.batchProcessorSequenceStart || 1)),
    indexPadding: Math.max(1, Math.min(8, Number(d.batchProcessorIndexPadding || 3))),
    outputFormat: item.kind === 'image' ? outputFormat : 'keep',
  });

  const patchItems = (items: BatchProcessorItem[]) => {
    const summary = summarizeBatchProgress(items);
    update({
      batchProcessorItems: items,
      batchProcessorProgress: summary,
      batchProcessorResults: items.filter((item) => item.status === 'success' || item.status === 'error'),
      status: summary.status === 'idle' ? 'idle' : summary.status,
    });
  };

  const appendFiles = async (files: File[]) => {
    if (files.length === 0) return;
    setLocalError('');
    setBusy(true);
    try {
      const uploaded: BatchProcessorItem[] = [];
      let skipped = 0;
      for (let i = 0; i < files.length; i += 1) {
        const item = await uploadBatchFile(files[i], storedItems.length + uploaded.length + i);
        if (item) uploaded.push(item);
        else skipped += 1;
      }
      const next = dedupeItems([...storedItems, ...uploaded]);
      update({
        batchProcessorItems: next,
        batchProcessorUploadNotice: skipped > 0
          ? `已加入 ${uploaded.length} 项，跳过 ${skipped} 个`
          : `已加入 ${uploaded.length} 项素材`,
      });
    } catch (error: any) {
      setLocalError(error?.message || '批量上传失败');
    } finally {
      setBusy(false);
    }
  };

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || []);
    event.target.value = '';
    if (files.length === 0) {
      update({ batchProcessorUploadNotice: '未选择文件' });
      return;
    }
    update({ batchProcessorUploadNotice: `正在上传 ${files.length} 个文件...` });
    void appendFiles(files);
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setDragActive(false);
    void appendFiles(Array.from(event.dataTransfer?.files || []));
  };

  const runRhStep = async (
    label: string,
    capability: string,
    imageUrl: string,
    options: { preferredToolId?: string; userParams?: Record<string, string | number | boolean>; signal?: AbortSignal } = {},
  ): Promise<string> => {
    const result = await runRhImageCapability({
      capability,
      imageUrl,
      preferredToolId: options.preferredToolId,
      userParams: options.userParams,
      signal: options.signal,
      onProgress: (progress) => {
        update({ batchProcessorUploadNotice: `${label}：${progress.message || progress.stage}` });
      },
    });
    return result.outputUrl;
  };

  const processImage = async (item: BatchProcessorItem, signal?: AbortSignal): Promise<{ url: string; steps: string[]; trimInfo?: BatchProcessorItem['trimInfo'] }> => {
    let url = item.url;
    const steps: string[] = [];
    let trimInfo: BatchProcessorItem['trimInfo'] | undefined;
    if (trimSelected) {
      const result = await opTrimBorder(url, {
        mode: trimMode,
        axis: trimAxis,
        threshold: trimThreshold,
        strategy: trimStrategy,
        manual: trimManual,
      });
      url = result.imageUrl;
      const removed = result.crop.removed;
      trimInfo = {
        top: removed.top,
        right: removed.right,
        bottom: removed.bottom,
        left: removed.left,
        width: result.crop.w,
        height: result.crop.h,
      };
      const totalRemoved = removed.top + removed.right + removed.bottom + removed.left;
      steps.push(totalRemoved > 0
        ? `裁边 上${removed.top}/右${removed.right}/下${removed.bottom}/左${removed.left}px`
        : '裁边 0px');
    }
    if (cutoutSelected) {
      url = await runRhStep('RH高清抠图', 'image.cutout', url, {
        preferredToolId: RH_IMAGE_CAPABILITY_PRESETS.cutout.preferredToolId,
        signal,
      });
      steps.push('RH抠图');
      if (cutoutOutputRatio !== 'keep') {
        const result = await opPadCanvas(url, { ratio: cutoutOutputRatio, background: d.batchProcessorPadBackground || '#00000000' });
        url = result.imageUrl;
        steps.push(`抠图比例 ${cutoutOutputRatio}`);
      }
    }
    if (expandSelected) {
      url = await runRhStep('RH AI扩图', 'image.expand', url, {
        userParams: expandPreset?.userParams,
        signal,
      });
      steps.push(`RH扩图 ${expandPreset?.label || ''}`.trim());
    }
    if (upscaleSelected) {
      url = await runRhStep('RH 4K高清放大', 'image.upscale', url, {
        preferredToolId: RH_IMAGE_CAPABILITY_PRESETS.upscale.preferredToolId,
        signal,
      });
      steps.push('RH 4K');
    }
    if (outputFormat !== 'keep') {
      const result = await opConvert(url, { format: outputFormat, quality: Number(d.batchProcessorQuality || 90) });
      url = result.imageUrl;
      steps.push(outputFormat.toUpperCase());
    }
    return { url, steps, trimInfo };
  };

  type BatchWorkEntry = { item: BatchProcessorItem; index: number };

  const runBatch = async (retryOnly = false) => {
    const deduped = dedupeItems(allItems);
    if (deduped.length === 0) {
      const msg = '请先上传文件、文件夹或连接上游素材';
      setLocalError(msg);
      update({ status: 'error', error: msg });
      return;
    }

    const targetKeys = new Set(
      deduped
        .filter((item) => !retryOnly || item.status === 'error')
        .map(batchItemKey),
    );
    if (retryOnly && targetKeys.size === 0) {
      update({ batchProcessorUploadNotice: '没有失败项需要重试' });
      return;
    }

    const baseItems: BatchProcessorItem[] = deduped.map((item) => (
      targetKeys.has(batchItemKey(item)) ? resetBatchItem(item) : item
    ));
    const workEntries: BatchWorkEntry[] = baseItems
      .map((item, index) => ({ item, index }))
      .filter((entry) => targetKeys.has(batchItemKey(entry.item)));

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    cancelRef.current = false;
    setLocalError('');
    update({
      status: 'running',
      error: '',
      batchProcessorItems: baseItems,
      batchProcessorResults: baseItems.filter((item) => item.status === 'success' || item.status === 'error'),
      batchProcessorProgress: summarizeBatchProgress(baseItems),
      batchProcessorUploadNotice: `${retryOnly ? '正在重试失败项' : '正在批处理'}：${workEntries.length} 项 · 并发 ${activeConcurrency} · 重试 ${retryCount}`,
    });

    let nextItems = [...baseItems];
    const patchAt = (index: number, patch: Partial<BatchProcessorItem>) => {
      nextItems = nextItems.map((item, i) => (i === index ? { ...item, ...patch } : item));
      patchItems(nextItems);
    };

    const results = await runBatchWorkPool<BatchWorkEntry, BatchProcessorItem>({
      items: workEntries,
      concurrency: activeConcurrency,
      retryCount,
      retryDelayMs: hasRhSteps ? 1600 : 500,
      continueOnError,
      signal: controller.signal,
      onItemStatus: (event) => {
        const masterIndex = event.item.index;
        if (event.status === 'start') {
          patchAt(masterIndex, {
            status: 'running',
            error: event.attempt > 1 ? `重试 ${event.attempt}/${event.maxAttempts}` : '',
          });
        } else if (event.status === 'retry') {
          patchAt(masterIndex, {
            status: 'running',
            error: `重试失败后继续：${event.error || '处理失败'}`,
          });
        }
      },
      worker: async (entry) => {
        const item = entry.item;
        let currentUrl = item.url;
        let stepsDone: string[] = [];
        let trimInfo: BatchProcessorItem['trimInfo'] | undefined;
        if (item.kind === 'image') {
          const processed = await processImage(item, controller.signal);
          currentUrl = processed.url;
          stepsDone = processed.steps;
          trimInfo = processed.trimInfo;
        } else {
          stepsDone = ['命名归档'];
        }

        const outputName = buildBatchOutputName(item, entry.index, namingSettingsFor(item));
        // 使用 /api/files/copy-to-output 收口命名后的真实文件；不写 imageUrls/videoUrls，避免画布自动外挂 OutputNode。
        const copied = await copyFileToOutput(currentUrl, outputName, 'batch');
        return {
          ...item,
          status: 'success' as const,
          resultUrl: copied.url,
          outputName: copied.filename,
          size: copied.size || item.size,
          stepsDone,
          trimInfo,
        };
      },
    });

    for (const result of results) {
      if (result.status === 'success' && result.value) {
        patchAt(result.item.index, result.value);
      } else if (result.status === 'cancelled') {
        patchAt(result.item.index, { status: 'skipped', error: result.error || '已取消' });
      } else {
        patchAt(result.item.index, { status: 'error', error: result.error || '处理失败' });
      }
    }
    if (controller.signal.aborted || cancelRef.current) {
      update({ status: 'idle', batchProcessorUploadNotice: '批处理已取消' });
    }
    abortRef.current = null;
  };

  const requestBatchProcessorRun = (mode: BatchProcessorRunMode) => {
    if (running) return;
    const requestId = mode === 'retry-failed'
      ? createCanvasNodeRunRequestId(id, 'batch-processor-retry')
      : '';
    update({ batchProcessorRunMode: mode, batchProcessorRunRequestId: requestId });
    // Wait one frame so Canvas receives the same persisted mode that enters
    // the execution-graph digest instead of a stale render closure.
    window.requestAnimationFrame(() => requestCanvasNodeRun(id, requestId ? { requestId } : {}));
  };

  const stopBatch = () => {
    cancelRef.current = true;
    abortRef.current?.abort();
    update({ status: 'idle', batchProcessorUploadNotice: '正在取消批处理...' });
  };

  useRunTrigger(id, async (reporter) => {
    if (running) return;
    const liveData = rf.getNode(id)?.data as Record<string, unknown> | undefined;
    const retryOnly = Boolean(reporter.runContext?.requestId)
      && reporter.runContext?.requestId === liveData?.batchProcessorRunRequestId
      && liveData?.batchProcessorRunMode === 'retry-failed';
    try {
      await runBatch(retryOnly);
    } finally {
      update({ batchProcessorRunMode: 'all', batchProcessorRunRequestId: '' });
    }
  }, 'batch-processor', { lifecycleAware: true });

  const clearItems = () => {
    cancelRef.current = true;
    update({
      batchProcessorItems: [],
      batchProcessorResults: [],
      batchProcessorProgress: summarizeBatchProgress([]),
      status: 'idle',
      error: '',
      batchProcessorUploadNotice: '队列已清空',
    });
    setLocalError('');
  };

  const openFilePicker = () => {
    if (busy || running) return;
    update({ batchProcessorUploadNotice: '正在打开文件选择器...' });
    fileInputRef.current?.click();
  };

  const openFolderPicker = () => {
    if (busy || running) return;
    update({ batchProcessorUploadNotice: '正在打开文件夹选择器...' });
    folderInputRef.current?.click();
  };

  const openBatchOutputFolder = async () => {
    if (folderBusy) return;
    setFolderBusy(true);
    setLocalError('');
    update({ batchProcessorUploadNotice: '正在打开 output/batch 文件夹...' });
    try {
      await openOutputFolder('batch');
      update({ batchProcessorUploadNotice: '已打开 output/batch 文件夹' });
    } catch (error: any) {
      const msg = error?.message || '打开输出文件夹失败';
      setLocalError(msg);
      update({ error: msg, batchProcessorUploadNotice: msg });
    } finally {
      setFolderBusy(false);
    }
  };

  const toggleStep = (operation: BatchProcessorOperation, value: boolean, label: string) => {
    const patch = createExclusiveBatchProcessorOperationPatch(value ? operation : null);
    if (operation === 'expand' && value) {
      update({
        ...patch,
        batchProcessorExpandPresetId: expandPresetId || RH_IMAGE_CAPABILITY_PRESETS.expand.defaultParamPresetId,
        batchProcessorUploadNotice: '批量扩图已启用，将调用 RH AI扩图',
      });
      return;
    }
    update({
      ...patch,
      batchProcessorUploadNotice: `${label} ${value ? '已启用' : '已关闭'}`,
    });
  };

  const resultItems = (Array.isArray(d.batchProcessorResults) ? d.batchProcessorResults : allItems)
    .filter((item: BatchProcessorItem) => item.status === 'success' || item.status === 'error')
    .slice(-8);

  return (
    <div
      className={`t8-node overflow-hidden ${selected ? 'ring-2' : ''}`}
      style={{
        width: 640,
        borderColor: selected ? 'var(--t8-accent)' : 'var(--t8-border-strong)',
        boxShadow: selected ? '0 0 0 2px color-mix(in srgb, var(--t8-accent) 30%, transparent)' : undefined,
      }}
    >
      <Handle type="target" position={Position.Left} style={{ background: PORT_COLOR.image, border: '1px solid var(--t8-bg-node)' }} />

      <div className="t8-node-header flex items-center gap-2 px-3 py-2">
        <div className="flex h-8 w-8 items-center justify-center rounded-md" style={{ background: '#f472b6', color: '#260516' }}>
          <Files size={17} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-bold">批量素材处理</div>
          <div className="truncate text-[10px]" style={{ color: 'var(--t8-text-muted)' }}>
            {progress.total} 项 · {progress.done}/{progress.total} · 成功 {progress.ok} · 失败 {progress.fail}
          </div>
        </div>
        <div className="flex items-center gap-1 text-[10px] font-bold" style={{ color: progress.fail ? '#ef4444' : running ? '#f59e0b' : '#16a34a' }}>
          {running ? <Loader2 size={13} className="animate-spin" /> : progress.fail ? <AlertCircle size={13} /> : <CheckCircle2 size={13} />}
          {running ? '处理中' : progress.total ? '待运行' : '待导入'}
        </div>
      </div>

      <div className="nodrag nowheel grid grid-cols-[minmax(0,1.05fr)_minmax(0,.95fr)] gap-3 p-3" onMouseDown={(event) => event.stopPropagation()} onWheelCapture={(event) => event.stopPropagation()}>
        <div className="min-w-0 space-y-2">
          <div
            className={`rounded-md border border-dashed p-3 transition-colors ${dragActive ? 'bg-cyan-500/10' : ''}`}
            style={{ borderColor: dragActive ? '#22d3ee' : 'var(--t8-border)' }}
            onDragOver={(event) => {
              event.preventDefault();
              setDragActive(true);
            }}
            onDragLeave={() => setDragActive(false)}
            onDrop={handleDrop}
          >
            <input ref={fileInputRef} type="file" multiple className="hidden" onChange={handleFileChange} />
            <input
              ref={folderInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={handleFileChange}
              {...({ webkitdirectory: '', directory: '' } as any)}
            />
            <div className="flex items-center gap-2">
              <button type="button" className="t8-btn px-2 py-1.5 text-xs" onClick={openFilePicker} disabled={busy || running}>
                {busy ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />}
                文件
              </button>
              <button type="button" className="t8-btn px-2 py-1.5 text-xs" onClick={openFolderPicker} disabled={busy || running}>
                <FolderOpen size={13} />
                文件夹
              </button>
              <button type="button" className="t8-btn px-2 py-1.5 text-xs" onClick={clearItems} disabled={running}>
                <RotateCcw size={13} />
                清空
              </button>
              <span className="ml-auto text-[10px]" style={{ color: 'var(--t8-text-dim)' }}>{d.batchProcessorUploadNotice || '拖拽也可导入'}</span>
            </div>
          </div>

          <div className="rounded-md border p-2" style={{ borderColor: 'var(--t8-border)' }}>
            <div className="mb-1 flex items-center justify-between text-[10px]" style={{ color: 'var(--t8-text-muted)' }}>
              <span>素材队列</span>
              <span>{progress.percent}%</span>
            </div>
            <div className="h-2 overflow-hidden rounded-full" style={{ background: 'var(--t8-bg-soft)' }}>
              <div className="h-full rounded-full transition-all" style={{ width: `${progress.percent}%`, background: progress.fail ? '#ef4444' : '#22c55e' }} />
            </div>
            <div className="mt-2 max-h-32 space-y-1 overflow-auto pr-1">
              {allItems.length === 0 ? (
                <div className="rounded border border-dashed px-2 py-3 text-center text-[11px]" style={{ borderColor: 'var(--t8-border)', color: 'var(--t8-text-dim)' }}>
                  无素材
                </div>
              ) : allItems.slice(0, 24).map((item) => {
                const statusMeta = batchStatusMeta(item.status);
                return (
                  <div
                    key={`${item.kind}:${item.url}`}
                    className="grid grid-cols-[14px_42px_1fr_auto] items-center gap-2 rounded px-2 py-1"
                    data-batch-status={item.status}
                    style={{ background: 'var(--t8-bg-soft)' }}
                  >
                    <span
                      className="relative inline-flex h-3 w-3 items-center justify-center rounded-full border"
                      title={statusMeta.label}
                      aria-label={statusMeta.label}
                      style={{ borderColor: statusMeta.color, boxShadow: `0 0 0 3px ${statusMeta.glow}` }}
                    >
                      <span
                        className={`h-1.5 w-1.5 rounded-full ${item.status === 'running' ? 'animate-pulse' : ''}`}
                        style={{ background: statusMeta.color }}
                      />
                    </span>
                    <span className="rounded px-1 py-0.5 text-center text-[10px] font-bold" style={{ color: 'var(--t8-text-main)', background: 'var(--t8-bg-node)' }}>{KIND_LABEL[item.kind]}</span>
                    <span className="truncate text-[11px]" style={{ color: 'var(--t8-text-main)' }} title={`${statusMeta.label} · ${item.relativePath || item.name}`}>{item.name}</span>
                    <span className="text-[10px]" style={{ color: 'var(--t8-text-dim)' }}>{formatMediaSize(item.size)}</span>
                  </div>
                );
              })}
              {allItems.length > 24 && <div className="text-right text-[10px]" style={{ color: 'var(--t8-text-dim)' }}>还有 {allItems.length - 24} 项</div>}
            </div>
          </div>

          <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-2">
            {running ? (
              <button type="button" className="t8-btn px-3 py-2 text-sm" onClick={stopBatch}>
                <X size={14} />
                取消
              </button>
            ) : (
              <button type="button" className="t8-btn t8-btn-primary px-3 py-2 text-sm" onClick={() => requestBatchProcessorRun('all')} disabled={allItems.length === 0 || busy}>
                <Play size={14} />
                开始批处理
              </button>
            )}
            <button type="button" className="t8-btn px-3 py-2 text-sm" onClick={() => requestBatchProcessorRun('retry-failed')} disabled={running || progress.fail === 0}>
              <RotateCcw size={14} />
              重试失败
            </button>
          </div>

          <div className="rounded-md border px-2 py-1.5 text-[10px]" style={{ borderColor: 'var(--t8-border)', color: 'var(--t8-text-muted)' }}>
            完成后只更新本节点结果，不自动铺素材节点
          </div>

          <button
            type="button"
            className="t8-btn w-full justify-center px-3 py-2 text-sm"
            onClick={openBatchOutputFolder}
            disabled={folderBusy}
            title="打开 output/batch 文件夹查看批处理结果"
          >
            {folderBusy ? <Loader2 size={14} className="animate-spin" /> : <FolderOpen size={14} />}
            打开输出文件夹
          </button>

          {(localError || d.error) && (
            <div className="flex items-start gap-1 rounded-md border px-2 py-1.5 text-[11px]" style={{ borderColor: '#ef444466', color: '#ef4444' }}>
              <AlertCircle size={13} className="mt-0.5 shrink-0" />
              <span>{localError || d.error}</span>
            </div>
          )}
        </div>

        <div className="min-w-0 space-y-2">
          <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-2">
            <div className="min-w-0">
              <FieldLabel>命名</FieldLabel>
              <select className="t8-select w-full px-2 py-1.5 text-xs" value={nameMode} onChange={(event) => update({ batchProcessorNameMode: event.target.value })} disabled={running}>
                <option value="original">用原名字</option>
                <option value="rename">改名字</option>
              </select>
            </div>
            <div className="min-w-0">
              <FieldLabel>格式</FieldLabel>
              <select className="t8-select w-full px-2 py-1.5 text-xs" value={outputFormat} onChange={(event) => update({ batchProcessorOutputFormat: event.target.value })} disabled={running}>
                <option value="keep">保持</option>
                <option value="png">PNG</option>
                <option value="jpg">JPG</option>
                <option value="webp">WEBP</option>
              </select>
            </div>
          </div>

          {nameMode === 'rename' && (
            <div className="min-w-0">
              <FieldLabel>改名模板</FieldLabel>
              <input className="t8-input w-full px-2 py-1.5 text-xs" value={renamePattern} onChange={(event) => update({ batchProcessorRenamePattern: event.target.value })} disabled={running} />
            </div>
          )}

          <div className="rounded-md border p-2" style={{ borderColor: 'var(--t8-border)', background: 'var(--t8-bg-soft)' }}>
            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-1 text-[10px] font-bold" style={{ color: 'var(--t8-text-main)' }}>
                <Sparkles size={12} />
                <span className="truncate">处理策略</span>
              </div>
              <span className="shrink-0 text-[9px]" style={{ color: 'var(--t8-text-dim)' }}>
                当前并发 {activeConcurrency}
              </span>
            </div>
            <div className="grid grid-cols-4 gap-1">
              <label className="min-w-0">
                <FieldLabel>本地并发</FieldLabel>
                <select className="t8-select w-full px-1.5 py-1 text-xs" value={localConcurrency} onChange={(event) => update({ batchProcessorLocalConcurrency: Number(event.target.value) })} disabled={running}>
                  {[1, 2, 3, 4, 6, 8].map((item) => <option key={item} value={item}>{item}</option>)}
                </select>
              </label>
              <label className="min-w-0">
                <FieldLabel>RH并发</FieldLabel>
                <select className="t8-select w-full px-1.5 py-1 text-xs" value={rhConcurrency} onChange={(event) => update({ batchProcessorRhConcurrency: Number(event.target.value) })} disabled={running}>
                  {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((item) => <option key={item} value={item}>{item}</option>)}
                </select>
              </label>
              <label className="min-w-0">
                <FieldLabel>重试</FieldLabel>
                <select className="t8-select w-full px-1.5 py-1 text-xs" value={retryCount} onChange={(event) => update({ batchProcessorRetryCount: Number(event.target.value) })} disabled={running}>
                  {[0, 1, 2, 3].map((item) => <option key={item} value={item}>{item}</option>)}
                </select>
              </label>
              <label className="flex min-w-0 items-end gap-1 rounded border px-1.5 py-1 text-[10px]" style={{ borderColor: 'var(--t8-border)', color: 'var(--t8-text-main)' }}>
                <input
                  type="checkbox"
                  checked={continueOnError}
                  onChange={(event) => update({ batchProcessorContinueOnError: event.target.checked })}
                  disabled={running}
                />
                失败继续
              </label>
            </div>
          </div>

          <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-2">
            <div className="min-w-0">
              <FieldLabel>扩图预设</FieldLabel>
              <select className="t8-select w-full px-2 py-1.5 text-xs" value={expandPresetId} onChange={(event) => update({ batchProcessorExpandPresetId: event.target.value })} disabled={running}>
                {EXPAND_PRESET_OPTIONS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
              </select>
            </div>
            <div className="min-w-0">
              <FieldLabel>抠图后比例</FieldLabel>
              <select className="t8-select w-full px-2 py-1.5 text-xs" value={cutoutOutputRatio} onChange={(event) => update({ batchProcessorCutoutOutputRatio: event.target.value })} disabled={running}>
                {RATIO_OPTIONS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-2">
            <ToggleStep icon={<Scissors size={13} />} label="去除黑/白/透明边" active={trimSelected} disabled={running} onChange={(value) => toggleStep('trim', value, '去除上下黑边')} />
            <ToggleStep icon={<Wand2 size={13} />} label="批量抠图" active={cutoutSelected} disabled={running} onChange={(value) => toggleStep('cutout', value, '批量抠图')} />
            <ToggleStep icon={<Maximize2 size={13} />} label="批量扩图" active={expandSelected} disabled={running} onChange={(value) => toggleStep('expand', value, '批量扩图')} />
            <ToggleStep icon={<ZoomIn size={13} />} label="高清放大" active={upscaleSelected} disabled={running} onChange={(value) => toggleStep('upscale', value, '高清放大')} />
          </div>

          {cutoutSelected && (
            <div className="rounded-md border p-2" style={{ borderColor: 'var(--t8-border)', background: 'var(--t8-bg-soft)' }}>
              <div className="mb-2 flex items-center gap-1 text-[10px] font-bold" style={{ color: 'var(--t8-text-main)' }}>
                <Wand2 size={12} />
                <span>批量抠图设置</span>
              </div>
              <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-2">
                <label className="min-w-0">
                  <FieldLabel>抠图方式</FieldLabel>
                  <div className="rounded border px-2 py-1.5 text-xs" style={{ borderColor: 'var(--t8-border)', color: 'var(--t8-text-main)', background: 'var(--t8-bg-node)' }}>
                    RH高清抠图
                  </div>
                </label>
                <label className="min-w-0">
                  <FieldLabel>抠图后比例</FieldLabel>
                  <select className="t8-select w-full px-2 py-1.5 text-xs" value={cutoutOutputRatio} onChange={(event) => update({ batchProcessorCutoutOutputRatio: event.target.value })} disabled={running}>
                    {RATIO_OPTIONS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
                  </select>
                </label>
              </div>
            </div>
          )}

          {expandSelected && (
            <div className="rounded-md border p-2" style={{ borderColor: 'var(--t8-border)', background: 'var(--t8-bg-soft)' }}>
              <div className="mb-2 flex items-center gap-1 text-[10px] font-bold" style={{ color: 'var(--t8-text-main)' }}>
                <Maximize2 size={12} />
                <span>批量扩图设置</span>
              </div>
              <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-2">
                <label className="min-w-0">
                  <FieldLabel>扩图方式</FieldLabel>
                  <div className="rounded border px-2 py-1.5 text-xs" style={{ borderColor: 'var(--t8-border)', color: 'var(--t8-text-main)', background: 'var(--t8-bg-node)' }}>
                    RH AI扩图
                  </div>
                </label>
                <label className="min-w-0">
                  <FieldLabel>RH预设</FieldLabel>
                  <select className="t8-select w-full px-2 py-1.5 text-xs" value={expandPresetId} onChange={(event) => update({ batchProcessorExpandPresetId: event.target.value })} disabled={running}>
                    {EXPAND_PRESET_OPTIONS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
                  </select>
                </label>
              </div>
            </div>
          )}

          {upscaleSelected && (
            <div className="rounded-md border p-2" style={{ borderColor: 'var(--t8-border)', background: 'var(--t8-bg-soft)' }}>
              <div className="mb-2 flex items-center gap-1 text-[10px] font-bold" style={{ color: 'var(--t8-text-main)' }}>
                <ZoomIn size={12} />
                <span>高清放大设置</span>
              </div>
              <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-2">
                <label className="min-w-0">
                  <FieldLabel>放大方式</FieldLabel>
                  <div className="rounded border px-2 py-1.5 text-xs" style={{ borderColor: 'var(--t8-border)', color: 'var(--t8-text-main)', background: 'var(--t8-bg-node)' }}>
                    RH 4K 高清放大
                  </div>
                </label>
                <label className="min-w-0">
                  <FieldLabel>执行队列</FieldLabel>
                  <div className="rounded border px-2 py-1.5 text-xs" style={{ borderColor: 'var(--t8-border)', color: 'var(--t8-text-main)', background: 'var(--t8-bg-node)' }}>
                    使用 RH 并发 {rhConcurrency}
                  </div>
                </label>
              </div>
            </div>
          )}

          {trimSelected && (
            <div className="rounded-md border p-2" style={{ borderColor: 'var(--t8-border)', background: 'var(--t8-bg-soft)' }}>
              <div className="mb-2 flex items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-1 text-[10px] font-bold" style={{ color: 'var(--t8-text-main)' }}>
                  <Scissors size={12} />
                  <span className="truncate">裁边设置</span>
                </div>
                <span className="shrink-0 text-[9px]" style={{ color: 'var(--t8-text-dim)' }}>
                  {trimStrategy === 'auto' ? `${trimModeLabel(trimMode)} · GAP ${trimThreshold}px` : '手动像素'}
                </span>
              </div>
              <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-2">
                <div className="min-w-0">
                  <FieldLabel>方式</FieldLabel>
                  <select className="t8-select w-full px-2 py-1.5 text-xs" value={trimStrategy} onChange={(event) => update({ batchProcessorTrimStrategy: event.target.value })} disabled={running}>
                    <option value="auto">自动检测</option>
                    <option value="manual">手动像素</option>
                  </select>
                </div>
                <div className="min-w-0">
                  <FieldLabel>裁剪方向</FieldLabel>
                  <select className="t8-select w-full px-2 py-1.5 text-xs" value={trimAxis} onChange={(event) => update({ batchProcessorTrimAxis: event.target.value })} disabled={running}>
                    {TRIM_AXIS_OPTIONS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
                  </select>
                </div>
              </div>
              {trimStrategy === 'auto' ? (
                <div className="mt-2 space-y-2">
                  <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-2">
                    <div className="min-w-0">
                      <FieldLabel>边缘类型</FieldLabel>
                      <select className="t8-select w-full px-2 py-1.5 text-xs" value={trimMode} onChange={(event) => update({ batchProcessorTrimMode: event.target.value })} disabled={running}>
                        {TRIM_MODE_OPTIONS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
                      </select>
                    </div>
                    <div className="min-w-0">
                      <FieldLabel>GAP 容差</FieldLabel>
                      <div className="flex items-center gap-2">
                        <input
                          className="nodrag nopan min-w-0 flex-1"
                          type="range"
                          min={0}
                          max={80}
                          step={1}
                          value={trimThreshold}
                          onChange={(event) => update({ batchProcessorTrimThreshold: Number(event.target.value) })}
                          disabled={running}
                          onMouseDown={(event) => event.stopPropagation()}
                        />
                        <span className="w-10 rounded px-1 py-0.5 text-center text-[10px] font-bold" style={{ background: 'var(--t8-bg-node)', color: 'var(--t8-text-main)' }}>{trimThreshold}px</span>
                      </div>
                    </div>
                  </div>
                  <div className="text-[10px] leading-snug" style={{ color: 'var(--t8-text-dim)' }}>
                    自动检测黑边、白边或透明边；GAP 越大，对压缩噪点、阴影和轻微灰边越宽容。
                  </div>
                </div>
              ) : (
                <div className="mt-2 grid grid-cols-4 gap-1">
                  {[
                    ['Top', '上', 'batchProcessorTrimManualTop', trimManual.top],
                    ['Right', '右', 'batchProcessorTrimManualRight', trimManual.right],
                    ['Bottom', '下', 'batchProcessorTrimManualBottom', trimManual.bottom],
                    ['Left', '左', 'batchProcessorTrimManualLeft', trimManual.left],
                  ].map(([key, label, field, value]) => (
                    <label key={key} className="min-w-0">
                      <span className="mb-0.5 block text-[9px] font-semibold" style={{ color: 'var(--t8-text-muted)' }}>{label}</span>
                      <input
                        className="t8-input w-full px-1.5 py-1 text-xs"
                        type="number"
                        min={0}
                        max={9999}
                        value={Number(value)}
                        onChange={(event) => update({ [String(field)]: Math.max(0, Number(event.target.value || 0)) })}
                        disabled={running}
                      />
                    </label>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="rounded-md border p-2" style={{ borderColor: 'var(--t8-border)' }}>
            <div className="mb-1 flex items-center gap-1 text-[10px] font-semibold" style={{ color: 'var(--t8-text-muted)' }}>
              <ImageIcon size={12} />
              完成反馈
            </div>
            <div className="max-h-40 space-y-1 overflow-auto pr-1">
              {resultItems.length === 0 ? (
                <div className="rounded border border-dashed px-2 py-3 text-center text-[11px]" style={{ borderColor: 'var(--t8-border)', color: 'var(--t8-text-dim)' }}>
                  尚无结果
                </div>
              ) : resultItems.map((item: BatchProcessorItem) => (
                <div key={`${item.id}:${item.outputName || item.name}`} className="rounded px-2 py-1" style={{ background: 'var(--t8-bg-soft)' }}>
                  <div className="flex items-center gap-1">
                    {item.status === 'success' ? <CheckCircle2 size={12} className="text-emerald-500" /> : <AlertCircle size={12} className="text-red-500" />}
                    <span className="min-w-0 flex-1 truncate text-[11px] font-semibold" style={{ color: 'var(--t8-text-main)' }}>{item.outputName || item.name}</span>
                    <span className="text-[10px]" style={{ color: 'var(--t8-text-dim)' }}>{item.stepsDone?.join(' / ')}</span>
                  </div>
                  {item.trimInfo ? (
                    <div className="mt-0.5 text-[10px]" style={{ color: 'var(--t8-text-dim)' }}>
                      裁掉：上 {item.trimInfo.top}px / 右 {item.trimInfo.right}px / 下 {item.trimInfo.bottom}px / 左 {item.trimInfo.left}px，输出 {item.trimInfo.width}×{item.trimInfo.height}
                    </div>
                  ) : null}
                  {item.resultUrl ? (
                    <a className="block truncate text-[10px] underline" href={item.resultUrl} target="_blank" rel="noreferrer" style={{ color: 'var(--t8-accent)' }}>{item.resultUrl}</a>
                  ) : item.error ? (
                    <div className="text-[10px]" style={{ color: '#ef4444' }}>{item.error}</div>
                  ) : null}
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-md border px-2 py-1.5 text-[10px] leading-relaxed" style={{ borderColor: 'var(--t8-border)', color: 'var(--t8-text-dim)' }}>
            开启后点击开始批处理；去除上下左右黑边/白边/透明边使用本机裁边，批量抠图、批量扩图和高清放大统一调用 RH 工具箱能力层，这三项仅图像素材可用；格式转换与归档在本机完成，视频/音频/3D 当前执行批量命名归档。
          </div>
        </div>
      </div>
    </div>
  );
}

export default memo(BatchProcessorNode);
