import { useEffect, useMemo, useRef, useState, type CSSProperties, type ChangeEvent, type MouseEvent } from 'react';
import { Eraser, Loader2, Maximize2, Scissors, Sparkles } from 'lucide-react';
import {
  runRhImageCapabilityBatch,
  type RunRhImageCapabilityBatchResult,
} from '../services/rhToolboxCapabilities';
import { cancelRh } from '../services/generation';
import {
  RH_IMAGE_CAPABILITY_PRESETS,
  resolveRhImageCapabilityPreset,
  type RhImageCapabilityPreset,
  type RhImageCapabilityPresetId,
} from '../utils/rhToolboxCapabilities';
import { logBus } from '../stores/logs';
import {
  registerSecondaryProviderActionExecutor,
  type QueueSecondaryProviderAction,
  type SecondaryProviderActionExecution,
} from '../utils/secondaryProviderAction';
import { extractRunProviderTrace } from '../utils/runProviderTrace';

interface RhImageCapabilityButtonProps {
  secondaryActionNodeId: string;
  queueSecondaryAction: QueueSecondaryProviderAction;
  sourceUrl?: string;
  sourceUrls?: string[];
  accent: string;
  isDark: boolean;
  isPixel?: boolean;
  preset?: RhImageCapabilityPresetId | RhImageCapabilityPreset | string;
  capability?: string;
  preferredToolId?: string;
  userParams?: Record<string, string | number | boolean>;
  label?: string;
  shortLabel?: string;
  title?: string;
  variant?: 'inline' | 'rail';
  retryCount?: number;
  retryDelayMs?: number;
  continueOnError?: boolean;
  onComplete: (result: RunRhImageCapabilityBatchResult) => void;
  onError?: (message: string) => void;
  onRunningChange?: (running: boolean) => void;
  style?: CSSProperties;
}

const INLINE_BUTTON_HEIGHT = 26;
const RAIL_BUTTON_SIZE = 36;

const formatError = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  return String(error || 'RH 工具箱处理失败');
};

function logRhImageCapabilityProgress(
  source: string,
  label: string,
  progress: { stage?: string; message?: string; taskId?: string; pollCount?: number },
  lastPollLogRef: { current: number },
) {
  const message = String(progress.message || '').trim();
  if (!message) return;
  const taskText = progress.taskId ? ` · taskId=${progress.taskId}` : '';
  if (progress.stage === 'poll') {
    const pollCount = Number(progress.pollCount || 0);
    if (pollCount > 1 && pollCount % 12 !== 0) return;
    if (pollCount && pollCount === lastPollLogRef.current) return;
    if (pollCount) lastPollLogRef.current = pollCount;
    logBus.debug(`${label}: ${message}${taskText}`, source);
    return;
  }
  if (progress.stage === 'success') {
    logBus.success(`${label}: ${message}${taskText}`, source);
    return;
  }
  if (progress.stage === 'error') {
    logBus.error(`${label}: ${message}${taskText}`, source);
    return;
  }
  logBus.info(`${label}: ${message}${taskText}`, source);
}

export default function RhImageCapabilityButton({
  secondaryActionNodeId,
  queueSecondaryAction,
  sourceUrl,
  sourceUrls,
  accent,
  isDark,
  isPixel = false,
  preset = 'cutout',
  capability: capabilityOverride,
  preferredToolId,
  userParams,
  label,
  shortLabel,
  title,
  variant = 'inline',
  retryCount = 2,
  retryDelayMs = 1200,
  continueOnError = true,
  onComplete,
  onError,
  onRunningChange,
  style,
}: RhImageCapabilityButtonProps) {
  const [running, setRunning] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [paramPickerOpen, setParamPickerOpen] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const activeTaskIdsRef = useRef<Set<string>>(new Set());
  const lastPollLogRef = useRef(0);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const cleanSourceUrls = useMemo(() => {
    const seen = new Set<string>();
    const urls = [...(sourceUrls || []), sourceUrl].filter(Boolean) as string[];
    return urls
      .map((url) => url.trim())
      .filter((url) => {
        if (!url || seen.has(url)) return false;
        seen.add(url);
        return true;
      });
  }, [sourceUrl, sourceUrls]);
  const resolvedPreset = useMemo(() => resolveRhImageCapabilityPreset(preset), [preset]);
  const paramPresets = resolvedPreset.paramPresets || [];
  const defaultParamPresetId = resolvedPreset.defaultParamPresetId || paramPresets[0]?.id || '';
  const [selectedParamPresetId, setSelectedParamPresetId] = useState(defaultParamPresetId);
  const capability = capabilityOverride || resolvedPreset.capability || RH_IMAGE_CAPABILITY_PRESETS.cutout.capability;
  const resolvedPreferredToolId = preferredToolId || resolvedPreset.preferredToolId;
  const buttonLabel = label || resolvedPreset.label || RH_IMAGE_CAPABILITY_PRESETS.cutout.label;
  const compactLabel = shortLabel || resolvedPreset.shortLabel || buttonLabel;
  const idleTitle = title || resolvedPreset.title || `调用 RH工具箱 ${buttonLabel}，并把结果输出为新素材节点`;
  const iconName = resolvedPreset.icon;
  const IdleIcon = iconName === 'sparkles' ? Sparkles : iconName === 'expand' ? Maximize2 : iconName === 'eraser' ? Eraser : Scissors;
  const isRail = variant === 'rail';
  const variantClassName = isRail ? 'rh-image-capability-button--rail' : 'rh-image-capability-button--inline';
  const visibleLabel = running ? (isRail ? '停' : '取消') : (isRail ? compactLabel : buttonLabel);
  const selectedParamPreset = paramPresets.find((item) => item.id === selectedParamPresetId) || paramPresets[0];
  const capabilityUserParams = useMemo(() => ({
    ...(selectedParamPreset?.userParams || {}),
    ...(userParams || {}),
  }), [selectedParamPreset, userParams]);
  const actionPresetId = Object.prototype.hasOwnProperty.call(RH_IMAGE_CAPABILITY_PRESETS, resolvedPreset.id)
    ? resolvedPreset.id as RhImageCapabilityPresetId
    : null;

  useEffect(() => {
    setSelectedParamPresetId(defaultParamPresetId);
  }, [defaultParamPresetId]);

  useEffect(() => {
    if (!paramPickerOpen) return undefined;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && wrapperRef.current?.contains(target)) return;
      setParamPickerOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setParamPickerOpen(false);
    };
    window.addEventListener('pointerdown', closeOnOutsidePointer, true);
    window.addEventListener('keydown', closeOnEscape, true);
    return () => {
      window.removeEventListener('pointerdown', closeOnOutsidePointer, true);
      window.removeEventListener('keydown', closeOnEscape, true);
    };
  }, [paramPickerOpen]);

  useEffect(() => {
    if (running) setParamPickerOpen(false);
  }, [running]);

  const handleParamPresetChange = (e: ChangeEvent<HTMLSelectElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setSelectedParamPresetId(e.target.value);
    setParamPickerOpen(false);
  };

  const openParamPicker = () => {
    if (paramPresets.length > 0 && !running) {
      setParamPickerOpen(true);
    }
  };

  const cancelActiveRunningHubTasks = async () => {
    const taskIds = Array.from(activeTaskIdsRef.current);
    if (taskIds.length === 0) return false;
    const results = await Promise.allSettled(taskIds.map((taskId) => cancelRh(taskId)));
    const failed: string[] = [];
    for (let i = 0; i < taskIds.length; i += 1) {
      const taskId = taskIds[i];
      const result = results[i];
      if (result.status === 'fulfilled') {
        logBus.success(`${buttonLabel}: 已请求取消 RH 后台任务 taskId=${taskId}`, `rh-image:${compactLabel}`);
      } else {
        const reason = result.reason?.message || result.reason;
        failed.push(`${taskId}: ${reason}`);
        logBus.error(`${buttonLabel}: 取消 RH 后台任务失败 taskId=${taskId} · ${reason}`, `rh-image:${compactLabel}`);
      }
    }
    if (failed.length > 0) throw new Error(failed.join('；'));
    return true;
  };

  useEffect(() => () => {
    abortRef.current?.abort();
    void cancelActiveRunningHubTasks().catch(() => undefined);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const executeAuthorizedCapabilityRef = useRef<(execution: SecondaryProviderActionExecution) => Promise<void>>(async () => undefined);
  executeAuthorizedCapabilityRef.current = async ({ action, reporter }) => {
    if (action.actionId !== 'rh-image.capability' || !actionPresetId || action.target !== actionPresetId) {
      throw new Error('RH 图像 action 与已注册能力不匹配');
    }
    const params = action.params;
    const controller = new AbortController();
    let providerRequested = false;
    let providerResponded = false;
    abortRef.current = controller;
    setRunning(true);
    onRunningChange?.(true);
    setError('');
    activeTaskIdsRef.current.clear();
    lastPollLogRef.current = 0;
    logBus.info(
      `${buttonLabel}: 开始处理 ${params.imageUrls.length} 张图像${selectedParamPreset ? ` · ${selectedParamPreset.label}` : ''}${params.preferredToolId ? ` · tool=${params.preferredToolId}` : ''}`,
      `rh-image:${compactLabel}`,
    );
    setMessage(params.imageUrls.length > 1 ? `准备批量${buttonLabel} 1/${params.imageUrls.length}` : `提交 RH ${buttonLabel}${selectedParamPreset ? ` · ${selectedParamPreset.label}` : ''}`);
    try {
      await reporter.providerRequest({
        provider: 'runninghub',
        model: params.preferredToolId || params.capability,
        actionId: action.actionId,
        actionTarget: action.target,
        itemCount: params.imageUrls.length,
      });
      providerRequested = true;
      const result = await runRhImageCapabilityBatch({
        capability: params.capability,
        preferredToolId: params.preferredToolId,
        userParams: params.userParams,
        imageUrls: params.imageUrls,
        signal: controller.signal,
        retryCount: params.retryCount,
        retryDelayMs: params.retryDelayMs,
        continueOnError: params.continueOnError,
        onProgress: (progress) => {
          if (progress.taskId) activeTaskIdsRef.current.add(progress.taskId);
          setMessage(progress.message);
          logRhImageCapabilityProgress(`rh-image:${compactLabel}`, buttonLabel, progress, lastPollLogRef);
          if (progress.taskId) {
            void reporter.providerPolling({
              provider: 'runninghub',
              model: params.preferredToolId || params.capability,
              upstreamTaskId: progress.taskId,
              pollCount: progress.pollCount,
            });
          }
        },
        onItemProgress: ({ index, total, attempt, maxAttempts, status, error: itemError }) => {
          const retryText = maxAttempts > 1 ? ` · 第 ${attempt}/${maxAttempts} 次` : '';
          if (status === 'retry') {
            setMessage(`第 ${index + 1}/${total} 张重试中${retryText}`);
            logBus.warn(`${buttonLabel}: 第 ${index + 1}/${total} 张失败后重试${retryText} · ${itemError || '未知错误'}`, `rh-image:${compactLabel}`);
          } else if (status === 'error') {
            setMessage(`第 ${index + 1}/${total} 张失败：${itemError || '未知错误'}`);
            logBus.error(`${buttonLabel}: 第 ${index + 1}/${total} 张失败 · ${itemError || '未知错误'}`, `rh-image:${compactLabel}`);
          } else if (status === 'success') {
            setMessage(`第 ${index + 1}/${total} 张完成`);
            logBus.success(`${buttonLabel}: 第 ${index + 1}/${total} 张完成`, `rh-image:${compactLabel}`);
          } else {
            setMessage(`准备第 ${index + 1}/${total} 张${retryText}`);
            logBus.info(`${buttonLabel}: 准备第 ${index + 1}/${total} 张${retryText}`, `rh-image:${compactLabel}`);
          }
        },
      });
      const trace = extractRunProviderTrace(result.results[0]?.result || result.results[0] || {});
      await reporter.providerResponse({
        provider: 'runninghub',
        model: params.preferredToolId || params.capability,
        upstreamTaskId: result.taskIds[0],
        ...trace,
        status: result.cancelled ? 'stopped' : result.failedItems.length > 0 ? 'partial' : 'succeeded',
      });
      providerResponded = true;
      onComplete(result);
      await reporter.output({
        status: result.cancelled ? 'stopped' : result.failedItems.length > 0 ? 'partial' : 'succeeded',
        assets: result.imageUrls.map((url) => ({ kind: 'image', sourceUrl: url })),
      });
      if (result.cancelled) {
        setMessage(`已取消，保留 ${result.imageUrls.length} 张结果`);
        logBus.warn(`${buttonLabel}: 已取消，保留 ${result.imageUrls.length} 张结果`, `rh-image:${compactLabel}`);
        throw new Error('RH 图像 action 已取消');
      } else if (result.failedItems.length > 0) {
        const warning = `${result.failedItems.length} 张失败，已输出 ${result.imageUrls.length} 张`;
        setMessage(warning);
        setError(warning);
        logBus.warn(`${buttonLabel}: ${warning}`, `rh-image:${compactLabel}`);
        throw new Error(warning);
      } else {
        setMessage(result.imageUrls.length > 1 ? `已输出 ${result.imageUrls.length} 张` : '已输出');
        logBus.success(
          `${buttonLabel}: 已输出 ${result.imageUrls.length} 张${result.taskIds.length ? ` · taskId=${result.taskIds.join(',')}` : ''}`,
          `rh-image:${compactLabel}`,
        );
      }
    } catch (err) {
      const nextError = formatError(err);
      if ((controller.signal.aborted || /action 已取消/.test(nextError)) && !/取消 RH 后台任务失败/.test(nextError)) {
        setMessage('已取消');
        logBus.warn(`${buttonLabel}: 已取消`, `rh-image:${compactLabel}`);
        if (providerRequested && !providerResponded) {
          await reporter.providerResponse({
            provider: 'runninghub',
            model: params.preferredToolId || params.capability,
            status: 'stopped',
          });
        }
        throw err;
      }
      setError(nextError);
      logBus.error(`${buttonLabel}: ${nextError}`, `rh-image:${compactLabel}`);
      onError?.(nextError);
      if (providerRequested && !providerResponded) {
        await reporter.providerResponse({
          provider: 'runninghub',
          model: params.preferredToolId || params.capability,
          status: 'failed',
        });
      }
      throw err;
    } finally {
      abortRef.current = null;
      activeTaskIdsRef.current.clear();
      setRunning(false);
      onRunningChange?.(false);
    }
  };

  useEffect(() => {
    if (!actionPresetId) return undefined;
    return registerSecondaryProviderActionExecutor(
      secondaryActionNodeId,
      'rh-image.capability',
      actionPresetId,
      (execution) => executeAuthorizedCapabilityRef.current(execution),
    );
  }, [actionPresetId, secondaryActionNodeId]);

  const runCapability = async (e: MouseEvent<HTMLButtonElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (running) {
      logBus.warn(`${buttonLabel}: 用户取消`, `rh-image:${compactLabel}`);
      if (activeTaskIdsRef.current.size > 0) {
        setMessage('正在请求取消 RH 后台任务...');
        try {
          await cancelActiveRunningHubTasks();
        } catch (cancelError) {
          const nextError = `取消 RH 后台任务失败：${formatError(cancelError)}`;
          setError(nextError);
          setMessage(nextError);
          onError?.(nextError);
          return;
        }
      } else {
        setMessage('等待 RH taskId，拿到后会立即取消后台任务');
      }
      abortRef.current?.abort();
      return;
    }
    if (cleanSourceUrls.length === 0 || !actionPresetId) return;
    try {
      queueSecondaryAction({
        actionId: 'rh-image.capability',
        target: actionPresetId,
        params: {
          capability,
          preferredToolId: resolvedPreferredToolId,
          userParams: Object.keys(capabilityUserParams).length > 0 ? capabilityUserParams : undefined,
          imageUrls: cleanSourceUrls,
          retryCount,
          retryDelayMs,
          continueOnError,
        },
      });
      setMessage('等待运行体检确认');
    } catch (err) {
      const nextError = formatError(err);
      setError(nextError);
      setMessage(nextError);
      onError?.(nextError);
    }
  };

  return (
    <div
      ref={wrapperRef}
      className="nodrag nopan rh-image-capability-button-wrap"
      data-rh-param-preset={selectedParamPreset?.id}
      onMouseEnter={openParamPicker}
      onFocusCapture={openParamPicker}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: paramPresets.length > 0 && paramPickerOpen ? 4 : 0,
        ...style,
      }}
    >
      <button
        type="button"
        className={`nodrag nopan rh-image-capability-button ${variantClassName}`}
        aria-label={running ? `取消 ${buttonLabel}` : buttonLabel}
        data-rh-capability={capability}
        data-rh-running={running ? 'true' : 'false'}
        onClick={runCapability}
        onMouseEnter={openParamPicker}
        onFocus={openParamPicker}
        onMouseDown={(e) => e.stopPropagation()}
        disabled={cleanSourceUrls.length === 0}
        title={error || message || (running ? 'RH 工具箱处理中，点击取消' : selectedParamPreset?.title || idleTitle)}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexDirection: isRail ? 'column' : 'row',
          gap: isRail ? 1 : 4,
          padding: isRail ? '4px 2px' : '4px 10px',
          width: isRail ? RAIL_BUTTON_SIZE : undefined,
          minWidth: isRail ? RAIL_BUTTON_SIZE : undefined,
          height: isRail ? RAIL_BUTTON_SIZE : INLINE_BUTTON_HEIGHT,
          background: isDark ? 'rgba(28,28,32,0.92)' : 'rgba(255,255,255,0.95)',
          color: accent,
          border: `1px solid ${accent}66`,
          borderRadius: isPixel ? 0 : 6,
          boxShadow: isPixel
            ? `2px 2px 0 ${accent}`
            : isDark
              ? '0 6px 24px rgba(0,0,0,0.4)'
              : '0 6px 24px rgba(0,0,0,0.12)',
          cursor: cleanSourceUrls.length === 0 ? 'not-allowed' : 'pointer',
          fontSize: isRail ? 10 : 12,
          fontWeight: 600,
          lineHeight: 1,
          whiteSpace: 'nowrap',
          opacity: cleanSourceUrls.length === 0 ? 0.56 : running ? 0.82 : 1,
        }}
      >
        {running ? <Loader2 size={12} className="animate-spin" /> : <IdleIcon size={12} />}
        <span
          style={{
            display: 'block',
            maxWidth: isRail ? RAIL_BUTTON_SIZE - 4 : undefined,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {visibleLabel}
        </span>
      </button>
      {paramPresets.length > 0 && paramPickerOpen && (
        <select
          className="nodrag nopan rh-image-capability-param-select"
          data-rh-param-select="resolution"
          aria-label={`${buttonLabel}分辨率`}
          value={selectedParamPreset?.id || ''}
          disabled={running}
          onChange={handleParamPresetChange}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          title="选择扩图输出分辨率"
          style={{
            width: isRail ? 126 : 144,
            height: isRail ? 26 : INLINE_BUTTON_HEIGHT,
            padding: '2px 6px',
            background: isDark ? 'rgba(28,28,32,0.96)' : 'rgba(255,255,255,0.98)',
            color: isDark ? '#f8fafc' : '#0f172a',
            border: `1px solid ${accent}66`,
            borderRadius: isPixel ? 0 : 6,
            boxShadow: isPixel ? `2px 2px 0 ${accent}` : '0 6px 18px rgba(0,0,0,0.18)',
            fontSize: 10,
            fontWeight: 600,
            outline: 'none',
            pointerEvents: 'auto',
          }}
        >
          {paramPresets.map((item) => (
            <option key={item.id} value={item.id}>{item.label}</option>
          ))}
        </select>
      )}
    </div>
  );
}
