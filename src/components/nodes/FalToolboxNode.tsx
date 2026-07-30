import { memo, useEffect, useMemo, useRef, useState, type CSSProperties, type WheelEvent } from 'react';
import { Handle, Position, useUpdateNodeInternals, type NodeProps } from '@xyflow/react';
import {
  AlertCircle,
  ArrowLeft,
  Box,
  Clock3,
  Layers,
  Loader2,
  Play,
  Search,
  Sparkles,
  Square,
  Star,
  Store,
} from 'lucide-react';
import { PORT_COLOR } from '../../config/portTypes';
import { useRunTrigger } from '../../hooks/useRunTrigger';
import { requestCanvasNodeRun } from '../../utils/canvasRunRequest';
import type { RunNodeLifecycleReporter } from '../../types/project';
import { runFalToolboxTool, getFalToolboxManifest, type RunFalToolboxProgress } from '../../services/falToolbox';
import { useThemeStore } from '../../stores/theme';
import { logBus } from '../../stores/logs';
import type { PromptTemplateKind } from '../../data/promptTemplateLibrary';
import {
  FAL_TOOLBOX_ALL_CATEGORY_ID,
  FAL_TOOLBOX_CAPABILITY_LABELS,
  filterFalToolboxTools,
  listFalToolboxTools,
  normalizeFalToolboxManifest,
  type FalToolboxTool,
  type FalToolboxUserParam,
} from '../../utils/falToolbox';
import {
  countExcludedMaterials,
  excludeMaterialId,
  filterExcludedMaterials,
  normalizeExcludedMaterialIds,
} from '../../utils/materialExclusion';
import { useHasAutoOutput } from './useHasAutoOutput';
import { useOrderedMaterials } from './useOrderedMaterials';
import { useUpdateNodeData } from './useUpdateNodeData';
import { useUpstreamMaterials, type Material } from './useUpstreamMaterials';
import { resolveMediaMentions, type MediaMention } from './mediaMentions';
import MaterialPreviewSection from './MaterialPreviewSection';
import MentionPromptInput from './MentionPromptInput';
import LoopingVideo from '../LoopingVideo';
import SmartImage from '../SmartImage';
import ResizableCorners from './ResizableCorners';

const handleStyle: CSSProperties = {
  width: 12,
  height: 12,
  border: 'none',
  zIndex: 20,
};

const FAL_TOOLBOX_FAVORITES_KEY = 't8:fal-toolbox:favorites:v1';
const FAL_TOOLBOX_RECENTS_KEY = 't8:fal-toolbox:recents:v1';
const FAL_BILLING_NOTICE = 'Fal模型会先预扣3.4币，生成完成后多退少补';
const FAL_TOOLBOX_DEVELOPER_MODULE = '../../utils/falToolboxDeveloper';

function readStoredToolIds(key: string): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(key) || '[]');
    return Array.isArray(parsed) ? parsed.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 80) : [];
  } catch {
    return [];
  }
}

function writeStoredToolIds(key: string, ids: string[]) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, JSON.stringify(Array.from(new Set(ids)).slice(0, 80)));
  } catch {
    // localStorage 失败不影响节点运行。
  }
}

function capabilityLabel(capability: string): string {
  return FAL_TOOLBOX_CAPABILITY_LABELS[capability] || capability;
}

function toolMatchesNodeSurface(tool: FalToolboxTool): boolean {
  return tool.ui?.showInNode !== false;
}

function promptTemplateKindForTool(tool?: FalToolboxTool): PromptTemplateKind {
  const capabilities = tool?.capabilities || [];
  if (capabilities.some((capability) => capability.startsWith('video.') || capability.startsWith('audio.'))) {
    return 'video';
  }
  return 'image';
}

function mediaMentionsForKey(value: unknown): MediaMention[] {
  return Array.isArray(value) ? (value as MediaMention[]) : [];
}

const FalToolboxNode = ({ id, data, selected }: NodeProps) => {
  const update = useUpdateNodeData(id);
  const updateNodeInternals = useUpdateNodeInternals();
  const { theme, style: themeStyle } = useThemeStore();
  const isDark = theme === 'dark';
  const isLight = theme === 'light';
  const isPixel = themeStyle === 'pixel';
  const hasAutoOutput = useHasAutoOutput(id);
  const d = (data || {}) as any;

  const [manifest, setManifest] = useState(() => normalizeFalToolboxManifest(getFalToolboxManifest()));
  const enabledTools = useMemo(
    () => listFalToolboxTools(manifest).filter(toolMatchesNodeSurface),
    [manifest],
  );
  const draftTools = useMemo(
    () => listFalToolboxTools(manifest, { includeDisabled: true }).filter((tool) => !tool.enabled),
    [manifest],
  );
  const categoryId = d.falToolboxCategoryId || FAL_TOOLBOX_ALL_CATEGORY_ID;
  const query = d.falToolboxSearchQuery || '';
  const viewMode = d.falToolboxViewMode || 'all';
  const activeToolId = d.falToolboxActiveToolId || '';
  const activeTool = enabledTools.find((tool) => tool.id === activeToolId);
  const status = d.status || 'idle';
  const isBusy = status === 'submitting' || status === 'polling';
  const urls: string[] = Array.isArray(d.urls) ? d.urls : [];
  const imageUrls: string[] = Array.isArray(d.imageUrls) ? d.imageUrls : (d.imageUrl ? [d.imageUrl] : []);
  const videoUrls: string[] = Array.isArray(d.videoUrls) ? d.videoUrls : (d.videoUrl ? [d.videoUrl] : []);
  const audioUrls: string[] = Array.isArray(d.audioUrls) ? d.audioUrls : (d.audioUrl ? [d.audioUrl] : []);
  const modelUrls: string[] = Array.isArray(d.modelUrls) ? d.modelUrls : [];
  const outputText = String(d.outputText || '');
  const userParamValues: Record<string, string | number | boolean> = d.falToolboxUserParams || {};
  const textInputValues: Record<string, string> = d.falToolboxTextInputs || {};
  const textInputMentions: Record<string, MediaMention[]> = d.falToolboxTextMentions || {};
  const userParamMentions: Record<string, MediaMention[]> = d.falToolboxUserParamMentions || {};
  const localPrompt = String(d.prompt || '');
  const promptMentions: MediaMention[] = Array.isArray(d.promptMentions) ? d.promptMentions : [];
  const [progressMessage, setProgressMessage] = useState('');
  const [favoriteToolIds, setFavoriteToolIds] = useState<string[]>(() => readStoredToolIds(FAL_TOOLBOX_FAVORITES_KEY));
  const [recentToolIds, setRecentToolIds] = useState<string[]>(() => readStoredToolIds(FAL_TOOLBOX_RECENTS_KEY));
  const abortRef = useRef<AbortController | null>(null);

  const initialSize = (d?.size && typeof d.size.w === 'number') ? d.size : { w: 380, h: 500 };
  const [size, setSize] = useState<{ w: number; h: number }>(initialSize);

  useEffect(() => {
    let disposed = false;
    const refreshManifest = () => {
      const base = getFalToolboxManifest();
      if (!import.meta.env.DEV) {
        setManifest(normalizeFalToolboxManifest(base));
        return;
      }
      import(/* @vite-ignore */ FAL_TOOLBOX_DEVELOPER_MODULE)
        .then(({ mergeFalToolboxManifestWithDeveloperDrafts }) => {
          if (!disposed) setManifest(mergeFalToolboxManifestWithDeveloperDrafts(base));
        })
        .catch(() => {
          if (!disposed) setManifest(normalizeFalToolboxManifest(base));
        });
    };
    refreshManifest();
    window.addEventListener('penguin:fal-toolbox-manifest-updated', refreshManifest);
    return () => {
      disposed = true;
      window.removeEventListener('penguin:fal-toolbox-manifest-updated', refreshManifest);
    };
  }, []);

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
  const materialOrder: string[] = Array.isArray(d.materialOrder) ? d.materialOrder : [];
  const orderedTexts = useOrderedMaterials(visibleUpstreamTexts, materialOrder);
  const orderedImages = useOrderedMaterials(visibleUpstreamImages, materialOrder);
  const orderedVideos = useOrderedMaterials(visibleUpstreamVideos, materialOrder);
  const orderedAudios = useOrderedMaterials(visibleUpstreamAudios, materialOrder);
  const mentionMaterials = useMemo(
    () => [...orderedImages, ...orderedVideos, ...orderedAudios],
    [orderedImages, orderedVideos, orderedAudios],
  );

  const filteredTools = useMemo(
    () => filterFalToolboxTools(manifest, {
      categoryId,
      query,
    }).filter(toolMatchesNodeSurface),
    [manifest, categoryId, query],
  );
  const favoriteSet = useMemo(() => new Set(favoriteToolIds), [favoriteToolIds]);
  const recentSet = useMemo(() => new Set(recentToolIds), [recentToolIds]);
  const displayTools = useMemo(() => {
    if (viewMode === 'favorites') return filteredTools.filter((tool) => favoriteSet.has(tool.id));
    if (viewMode === 'recent') {
      const order = new Map(recentToolIds.map((toolId, index) => [toolId, index]));
      return filteredTools
        .filter((tool) => recentSet.has(tool.id))
        .slice()
        .sort((a, b) => (order.get(a.id) ?? 999) - (order.get(b.id) ?? 999));
    }
    return filteredTools;
  }, [favoriteSet, filteredTools, recentSet, recentToolIds, viewMode]);
  const categoryCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const tool of enabledTools) counts.set(tool.categoryId, (counts.get(tool.categoryId) || 0) + 1);
    return counts;
  }, [enabledTools]);
  const activeTextInputs = useMemo(
    () => (activeTool?.inputSchema || []).filter((input) => input.kind === 'text'),
    [activeTool],
  );
  const activeMediaInputs = useMemo(
    () => (activeTool?.inputSchema || []).filter((input) => input.kind !== 'text'),
    [activeTool],
  );
  const templateKind = useMemo(() => promptTemplateKindForTool(activeTool), [activeTool]);

  const accent = activeTool?.ui?.accent || (isPixel ? 'var(--px-ink)' : isLight ? '#7c3aed' : '#c084fc');
  const bg = isPixel ? 'var(--px-surface)' : isLight ? '#ffffff' : 'rgba(18, 18, 26, 0.96)';
  const surface = isPixel ? 'var(--px-muted)' : isLight ? 'rgba(124,58,237,0.08)' : 'rgba(255,255,255,0.06)';
  const surfaceStrong = isPixel ? 'var(--px-yellow)' : isLight ? 'rgba(124,58,237,0.16)' : 'rgba(192,132,252,0.14)';
  const text = isPixel ? 'var(--px-ink)' : isLight ? '#0f172a' : '#f5f3ff';
  const subText = isPixel ? 'var(--px-ink-soft)' : isLight ? '#64748b' : 'rgba(245,243,255,0.62)';
  const border = isPixel ? 'var(--px-ink)' : isLight ? 'rgba(124,58,237,0.24)' : 'rgba(192,132,252,0.22)';
  const errorText = isPixel ? '#dc2626' : '#fca5a5';

  const rootStyle: CSSProperties = {
    background: bg,
    color: text,
    width: size.w,
    height: size.h,
    minWidth: 320,
    minHeight: 360,
    border: `2px solid ${selected ? accent : border}`,
    boxShadow: isPixel ? (selected ? '5px 5px 0 var(--px-ink)' : '3px 3px 0 var(--px-ink)') : 'var(--t8-node-shadow, 0 12px 30px rgba(0,0,0,0.28))',
    borderRadius: isPixel ? 8 : 14,
    overflow: 'visible',
  };

  const setMaterialOrder = (newOrder: string[]) => update({ materialOrder: newOrder });
  const handleHorizontalWheel = (event: WheelEvent<HTMLDivElement>) => {
    event.stopPropagation();
    const el = event.currentTarget;
    if (el.scrollWidth <= el.clientWidth) return;
    const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
    if (!delta) return;
    event.preventDefault();
    el.scrollLeft += delta;
  };
  const handleExcludeUpstreamMaterial = (m: Material) => {
    if (m.origin !== 'upstream') return;
    update({
      excludedMaterialIds: excludeMaterialId(excludedMaterialIds, m.id),
      materialOrder: materialOrder.filter((itemId) => itemId !== m.id),
    });
  };
  const handleRestoreExcludedMaterials = () => update({ excludedMaterialIds: [] });

  const setActiveTool = (tool: FalToolboxTool) => {
    const nextRecent = [tool.id, ...recentToolIds.filter((toolId) => toolId !== tool.id)].slice(0, 24);
    setRecentToolIds(nextRecent);
    writeStoredToolIds(FAL_TOOLBOX_RECENTS_KEY, nextRecent);
    setProgressMessage('');
    update({
      falToolboxActiveToolId: tool.id,
      falToolboxUserParams: {},
      falToolboxUserParamMentions: {},
      status: 'idle',
      requestId: '',
      urls: [],
      imageUrl: '',
      imageUrls: [],
      videoUrl: '',
      videoUrls: [],
      audioUrl: '',
      audioUrls: [],
      modelUrls: [],
      modelUrl: '',
      directModelUrl: '',
      directModelUrls: [],
      outputText: '',
      error: '',
    });
  };

  const toggleFavoriteTool = (tool: FalToolboxTool) => {
    const next = favoriteSet.has(tool.id)
      ? favoriteToolIds.filter((toolId) => toolId !== tool.id)
      : [tool.id, ...favoriteToolIds];
    setFavoriteToolIds(next);
    writeStoredToolIds(FAL_TOOLBOX_FAVORITES_KEY, next);
  };

  const setUserParam = (param: FalToolboxUserParam, value: string | number | boolean) => {
    update({
      falToolboxUserParams: {
        ...userParamValues,
        [param.key]: value,
      },
    });
  };

  const textInputValue = (input: FalToolboxTool['inputSchema'][number]): string => {
    const value = textInputValues[input.key];
    if (typeof value === 'string') return value;
    return input.key === 'prompt' ? localPrompt : '';
  };

  const textInputMentionsFor = (input: FalToolboxTool['inputSchema'][number]): MediaMention[] => {
    const mentions = mediaMentionsForKey(textInputMentions[input.key]);
    return mentions.length || input.key !== 'prompt' ? mentions : promptMentions;
  };

  const setTextInput = (input: FalToolboxTool['inputSchema'][number], value: string, mentions: MediaMention[]) => {
    const patch: Record<string, unknown> = {
      falToolboxTextInputs: {
        ...textInputValues,
        [input.key]: value,
      },
      falToolboxTextMentions: {
        ...textInputMentions,
        [input.key]: mentions,
      },
    };
    if (input.key === 'prompt') {
      patch.prompt = value;
      patch.promptMentions = mentions;
    }
    update(patch);
  };

  const setUserParamText = (param: FalToolboxUserParam, value: string, mentions: MediaMention[]) => {
    update({
      falToolboxUserParams: {
        ...userParamValues,
        [param.key]: value,
      },
      falToolboxUserParamMentions: {
        ...userParamMentions,
        [param.key]: mentions,
      },
    });
  };

  const collectResolvedTextInputs = (): Record<string, string> => {
    const resolved: Record<string, string> = {};
    for (const input of activeTextInputs) {
      const value = resolveMediaMentions(textInputValue(input), textInputMentionsFor(input), mentionMaterials).trim();
      if (value) resolved[input.key] = value;
    }
    return resolved;
  };

  const collectResolvedUserParams = (): Record<string, string | number | boolean> => {
    const resolved: Record<string, string | number | boolean> = { ...userParamValues };
    for (const param of activeTool?.userParams || []) {
      if (param.kind !== 'text' && param.kind !== 'textarea') continue;
      const value = String(userParamValues[param.key] ?? param.defaultValue ?? '');
      const mentions = mediaMentionsForKey(userParamMentions[param.key]);
      resolved[param.key] = resolveMediaMentions(value, mentions, mentionMaterials);
    }
    return resolved;
  };

  const handleRun = async (reporter?: RunNodeLifecycleReporter) => {
    if (!activeTool) {
      update({ status: 'error', error: '请先选择 Fal 超市工具' });
      throw new Error('请先选择 Fal 超市工具');
    }
    abortRef.current?.abort();
    const aborter = new AbortController();
    abortRef.current = aborter;
    setProgressMessage('准备运行...');
    update({
      status: 'submitting',
      error: '',
      requestId: '',
      urls: [],
      imageUrl: '',
      imageUrls: [],
      videoUrl: '',
      videoUrls: [],
      audioUrl: '',
      audioUrls: [],
      modelUrls: [],
      modelUrl: '',
      directModelUrl: '',
      directModelUrls: [],
      outputText: '',
    });
    const source = `fal-toolbox:${id}`;
    await reporter?.providerRequest({ provider: 'fal', model: activeTool.id });
    try {
      const resolvedTextInputs = collectResolvedTextInputs();
      const resolvedUserParams = collectResolvedUserParams();
      const firstResolvedPrompt = resolvedTextInputs.prompt || Object.values(resolvedTextInputs)[0] || '';
      const onProgress = async (progress: RunFalToolboxProgress) => {
        setProgressMessage(progress.message);
        if (progress.requestId) update({ status: progress.stage === 'poll' ? 'polling' : 'submitting', requestId: progress.requestId });
        const payload = {
          provider: 'fal',
          toolId: activeTool.id,
          requestId: progress.requestId || null,
          transportHttpStatus: progress.transportHttpStatus,
          upstreamHttpStatus: progress.upstreamHttpStatus,
          usage: progress.usage,
          httpStatusSource: 'local-backend',
          pollCount: progress.pollCount || null,
          stage: progress.stage,
          message: progress.message,
        };
        if (progress.stage === 'poll') await reporter?.polling(payload);
        else if (progress.stage === 'submit' && progress.requestId) await reporter?.providerSubmitted(payload);
        else await reporter?.progress(payload);
      };
      const result = await runFalToolboxTool({
        toolId: activeTool.id,
        manifest,
        inputs: {
          texts: orderedTexts.map((m) => m.url),
          images: orderedImages.map((m) => m.url),
          videos: orderedVideos.map((m) => m.url),
          audios: orderedAudios.map((m) => m.url),
        },
        inputValues: resolvedTextInputs,
        userParams: resolvedUserParams,
        signal: aborter.signal,
        submissionKey: reporter?.providerSubmissionKey,
        onProgress,
      });
      const textOutputs = result.textOutputs.filter(Boolean);
      const textValue = textOutputs.join('\n\n');
      await reporter?.providerResponse({
        provider: 'fal',
        model: activeTool.id,
        requestId: result.requestId,
        transportHttpStatus: result.transportHttpStatus,
        upstreamHttpStatus: result.upstreamHttpStatus,
        usage: result.usage,
        status: 'succeeded',
        httpStatusSource: 'local-backend',
      });
      update({
        status: 'success',
        requestId: result.requestId || '',
        urls: result.urls,
        imageUrls: result.imageUrls,
        imageUrl: result.imageUrls[0] || '',
        videoUrls: result.videoUrls,
        videoUrl: result.videoUrls[0] || '',
        audioUrls: result.audioUrls,
        audioUrl: result.audioUrls[0] || '',
        modelUrls: result.modelUrls,
        modelUrl: result.modelUrls[0] || '',
        directModelUrl: result.modelUrls[0] || '',
        directModelUrls: result.modelUrls,
        outputText: textValue,
        text: textValue,
        prompt: localPrompt || firstResolvedPrompt || textValue,
        promptResolved: firstResolvedPrompt,
        lastPrompt: firstResolvedPrompt,
        texts: textOutputs,
        textSegments: textOutputs,
        raw: result.raw,
        provider: 'fal',
        model: activeTool.id,
        transportHttpStatus: result.transportHttpStatus,
        upstreamHttpStatus: result.upstreamHttpStatus,
        usage: result.usage,
        error: '',
      });
      const total = result.urls.length + textOutputs.length;
      setProgressMessage(`完成 · ${total} 个输出`);
      logBus.success(`${activeTool.title} 完成 · ${total} 个输出`, source);
    } catch (error: any) {
      const message = error?.message || 'Fal超市运行失败';
      await reporter?.providerResponse({
        provider: 'fal',
        model: activeTool.id,
        requestId: error?.requestId,
        transportHttpStatus: error?.transportHttpStatus,
        upstreamHttpStatus: error?.upstreamHttpStatus,
        status: aborter.signal.aborted ? 'stopped' : 'failed',
        error: { message, code: error?.code },
        httpStatusSource: 'local-backend',
      });
      update({ status: 'error', error: message });
      setProgressMessage('');
      logBus.error(message, source);
      throw error;
    }
  };

  const handleStop = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    update({ status: 'idle', error: '', requestId: '' });
    setProgressMessage('已停止');
  };

  useRunTrigger(id, async (reporter) => {
    if (isBusy) return;
    await handleRun(reporter);
  }, undefined, { lifecycleAware: true });

  const onResize = (_event: any, params: { width: number; height: number }) => {
    const next = { w: Math.round(params.width), h: Math.round(params.height) };
    setSize(next);
    update({ size: next });
    updateNodeInternals(id);
  };

  const renderHeader = () => (
    <div
      className="flex items-center gap-2 px-3 py-2 shrink-0"
      style={{
        borderBottom: `1px solid ${border}`,
        background: isPixel ? 'var(--px-surface)' : activeTool ? `${accent}1c` : surface,
        borderRadius: isPixel ? '6px 6px 0 0' : '12px 12px 0 0',
      }}
    >
      <div
        className="flex items-center justify-center shrink-0"
        style={{
          width: 28,
          height: 28,
          borderRadius: isPixel ? 6 : 8,
          background: surfaceStrong,
          color: accent,
          border: isPixel ? `2px solid ${border}` : `1px solid ${border}`,
        }}
      >
        <Store size={15} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="font-bold leading-tight truncate" style={{ fontSize: 15 }}>Fal超市</div>
        <div className="text-[10px] truncate" style={{ color: subText }}>
          {activeTool ? `${activeTool.title} · ${activeTool.capabilities.map(capabilityLabel).join(' / ')}` : 'FAL 模型能力超市'}
        </div>
      </div>
    </div>
  );

  const renderLauncher = () => (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="px-3 py-2 shrink-0 space-y-2" style={{ borderBottom: `1px solid ${border}` }}>
        <div className="text-[10px] leading-snug px-1" style={{ color: subText }}>
          {FAL_BILLING_NOTICE}
        </div>
        <div className="flex items-center gap-2 px-2 py-1.5 rounded nodrag" style={{ background: surface, border: `1px solid ${border}` }} onMouseDown={(e) => e.stopPropagation()}>
          <Search size={13} style={{ color: subText }} />
          <input
            value={query}
            onChange={(e) => update({ falToolboxSearchQuery: e.target.value })}
            placeholder="搜索 FAL 模型 / 能力..."
            className="nodrag nowheel flex-1 bg-transparent outline-none text-xs"
            style={{ color: text }}
          />
        </div>
        <div
          className="flex gap-1 overflow-x-auto nodrag nowheel"
          onMouseDown={(e) => e.stopPropagation()}
          onWheel={handleHorizontalWheel}
        >
          {[
            { id: 'all', name: '全部工具', icon: <Store size={11} /> },
            { id: 'favorites', name: `收藏 ${favoriteToolIds.length}`, icon: <Star size={11} /> },
            { id: 'recent', name: `最近 ${recentToolIds.length}`, icon: <Clock3 size={11} /> },
          ].map((item) => {
            const active = viewMode === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => update({ falToolboxViewMode: item.id })}
                className="nodrag shrink-0 rounded-full px-2 py-0.5 text-[11px] inline-flex items-center gap-1"
                style={{
                  background: active ? accent : surface,
                  color: active ? (isPixel ? 'var(--px-surface)' : '#120818') : text,
                  border: `1px solid ${active ? accent : border}`,
                  fontWeight: active ? 700 : 500,
                }}
              >
                {item.icon}
                {item.name}
              </button>
            );
          })}
        </div>
        <div
          className="flex gap-1 overflow-x-auto nodrag nowheel"
          onMouseDown={(e) => e.stopPropagation()}
          onWheel={handleHorizontalWheel}
        >
          {[{ id: FAL_TOOLBOX_ALL_CATEGORY_ID, name: '全部' }, ...manifest.categories].map((category) => {
            const active = categoryId === category.id;
            const count = category.id === FAL_TOOLBOX_ALL_CATEGORY_ID ? enabledTools.length : categoryCounts.get(category.id) || 0;
            return (
              <button
                key={category.id}
                type="button"
                onClick={() => update({ falToolboxCategoryId: category.id })}
                className="nodrag shrink-0 rounded-full px-2 py-0.5 text-[11px]"
                style={{
                  background: active ? accent : surface,
                  color: active ? (isPixel ? 'var(--px-surface)' : '#120818') : text,
                  border: `1px solid ${active ? accent : border}`,
                  fontWeight: active ? 700 : 500,
                }}
              >
                {category.name} {count}
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-2 nodrag nowheel" onMouseDown={(e) => e.stopPropagation()}>
        {enabledTools.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-center gap-2 px-4" style={{ color: subText }}>
            <Sparkles size={22} />
            <div className="text-xs font-semibold" style={{ color: text }}>暂未发布 FAL 工具</div>
            <div className="text-[11px] leading-relaxed">
              当前 manifest 有 {draftTools.length} 个维护模板。发布后会自动出现在这里。
            </div>
          </div>
        ) : displayTools.length === 0 ? (
          <div className="h-full flex items-center justify-center text-[11px]" style={{ color: subText }}>
            {viewMode === 'favorites' ? '还没有收藏工具' : viewMode === 'recent' ? '还没有最近使用记录' : '无匹配工具'}
          </div>
        ) : (
          <div className="space-y-2">
            {displayTools.map((tool) => (
              <div
                key={tool.id}
                role="button"
                tabIndex={0}
                onClick={() => setActiveTool(tool)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    setActiveTool(tool);
                  }
                }}
                className="nodrag w-full text-left rounded-lg p-2 transition"
                style={{ background: surface, color: text, border: `1px solid ${border}` }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = surfaceStrong;
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = surface;
                }}
              >
                <div className="flex items-center gap-2">
                  <Sparkles size={13} style={{ color: tool.ui?.accent || accent }} />
                  <span className="flex-1 min-w-0 text-xs font-bold truncate">{tool.title}</span>
                  <span
                    role="button"
                    tabIndex={0}
                    title={favoriteSet.has(tool.id) ? '取消收藏' : '收藏工具'}
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      toggleFavoriteTool(tool);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        e.stopPropagation();
                        toggleFavoriteTool(tool);
                      }
                    }}
                    className="nodrag inline-flex items-center justify-center rounded-full"
                    style={{
                      width: 20,
                      height: 20,
                      color: favoriteSet.has(tool.id) ? accent : subText,
                      background: favoriteSet.has(tool.id) ? surfaceStrong : bg,
                      border: `1px solid ${border}`,
                    }}
                  >
                    <Star size={11} fill={favoriteSet.has(tool.id) ? 'currentColor' : 'none'} />
                  </span>
                  <span className="text-[9px] truncate max-w-[110px]" style={{ color: subText }}>{tool.endpoint}</span>
                </div>
                <div className="text-[10px] mt-1 line-clamp-2" style={{ color: subText }}>{tool.description}</div>
                <div className="flex flex-wrap gap-1 mt-1.5">
                  {tool.capabilities.slice(0, 4).map((capability) => (
                    <span key={capability} className="rounded px-1 py-0.5 text-[9px]" style={{ background: bg, color: subText, border: `1px solid ${border}` }}>
                      {capabilityLabel(capability)}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );

  const renderUserParam = (param: FalToolboxUserParam) => {
    const value = userParamValues[param.key] ?? param.defaultValue ?? (param.kind === 'boolean' ? false : '');
    const commonStyle: CSSProperties = {
      width: '100%',
      background: surface,
      color: text,
      border: `1px solid ${border}`,
      borderRadius: 6,
      padding: '5px 7px',
      fontSize: 11,
      outline: 'none',
    };
    if (param.kind === 'boolean') {
      return (
        <label key={param.key} className="flex items-center gap-2 text-[11px] nodrag" style={{ color: text }}>
          <input
            type="checkbox"
            checked={value === true || value === 'true'}
            onChange={(e) => setUserParam(param, e.target.checked)}
            style={{ accentColor: String(accent) }}
          />
          {param.label}
        </label>
      );
    }
    if (param.kind === 'select') {
      return (
        <label key={param.key} className="block text-[10px] space-y-1" style={{ color: subText }}>
          <span>{param.label}</span>
          <select
            value={String(value)}
            onChange={(e) => setUserParam(param, e.target.value)}
            className="nodrag nowheel"
            style={commonStyle}
          >
            {(param.options || []).map((option) => (
              <option key={String(option)} value={String(option)}>{String(option)}</option>
            ))}
          </select>
        </label>
      );
    }
    if (param.kind === 'textarea' || param.kind === 'text') {
      return (
        <div key={param.key} className="block text-[10px] space-y-1" style={{ color: subText }}>
          <span>{param.label}</span>
          <MentionPromptInput
            title={`Fal超市 · ${param.label}`}
            value={String(value)}
            mentions={mediaMentionsForKey(userParamMentions[param.key])}
            materials={mentionMaterials}
            placeholder={param.placeholder}
            onChange={(nextValue, mentions) => setUserParamText(param, nextValue, mentions)}
            isDark={isDark}
            isPixel={isPixel}
            promptTemplateKind={templateKind}
            className="nodrag nowheel"
            style={{
              ...commonStyle,
              minHeight: param.kind === 'textarea' ? 68 : 42,
              paddingRight: 64,
            }}
          />
        </div>
      );
    }
    return (
      <label key={param.key} className="block text-[10px] space-y-1" style={{ color: subText }}>
        <span>{param.label}</span>
        <input
          type={param.kind === 'number' ? 'number' : 'text'}
          value={String(value)}
          min={param.min}
          max={param.max}
          step={param.step}
          placeholder={param.placeholder}
          onChange={(e) => setUserParam(param, param.kind === 'number' ? (e.target.value === '' ? '' : Number(e.target.value)) : e.target.value)}
          className="nodrag nowheel"
          style={commonStyle}
        />
      </label>
    );
  };

  const renderRunner = () => {
    if (!activeTool) {
      return (
        <div className="flex-1 flex flex-col items-center justify-center gap-2 text-center px-5" style={{ color: subText }}>
          <AlertCircle size={22} />
          <div className="text-xs">当前工具不可用或已被禁用</div>
          <button type="button" onClick={() => update({ falToolboxActiveToolId: '' })} className="nodrag text-xs px-3 py-1 rounded" style={{ background: surface, color: text, border: `1px solid ${border}` }}>
            返回工具列表
          </button>
        </div>
      );
    }

    return (
      <div className="flex-1 flex flex-col min-h-0">
        <div className="px-3 py-2 shrink-0 flex items-center gap-2" style={{ borderBottom: `1px solid ${border}` }}>
          <button
            type="button"
            onClick={() => update({ falToolboxActiveToolId: '' })}
            className="nodrag flex items-center gap-1 rounded px-2 py-1 text-[11px]"
            style={{ background: surface, color: text, border: `1px solid ${border}` }}
          >
            <ArrowLeft size={12} /> 列表
          </button>
          <div className="flex-1 min-w-0 text-[10px] truncate" style={{ color: subText }}>
            {activeMediaInputs.length > 0
              ? activeMediaInputs.map((input) => `${input.label || input.key}:${input.kind}`).join(' · ')
              : activeTextInputs.length > 0
              ? 'Prompt 可本地输入或接上游文本'
              : '无必填素材输入'}
          </div>
        </div>
        <div className="flex-1 overflow-y-auto px-3 py-2 space-y-3 nodrag nowheel" onMouseDown={(e) => e.stopPropagation()}>
          {activeTextInputs.length > 0 && (
            <div className="space-y-2 rounded-lg p-2" style={{ background: surface, border: `1px solid ${border}` }}>
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1 text-[11px] font-bold" style={{ color: text }}>
                  <Sparkles size={12} /> Prompt
                </div>
                {orderedTexts.length > 0 && (
                  <span className="text-[10px]" style={{ color: subText }}>
                    本地为空时使用上游文本
                  </span>
                )}
              </div>
              {activeTextInputs.map((input) => (
                <div key={input.key} className="block text-[10px] space-y-1" style={{ color: subText }}>
                  <span>{input.label || input.key}{input.required !== false ? '' : '（可选）'}</span>
                  <MentionPromptInput
                    title={`Fal超市 · ${input.label || input.key}`}
                    value={textInputValue(input)}
                    mentions={textInputMentionsFor(input)}
                    materials={mentionMaterials}
                    onChange={(nextValue, mentions) => setTextInput(input, nextValue, mentions)}
                    placeholder={input.defaultValue || '输入提示词，也可以 @ 引用上游图片、视频、音频'}
                    isDark={isDark}
                    isPixel={isPixel}
                    promptTemplateKind={templateKind}
                    className="nodrag nowheel"
                    style={{
                      width: '100%',
                      minHeight: 72,
                      background: surface,
                      color: text,
                      border: `1px solid ${border}`,
                      borderRadius: 6,
                      padding: '7px 64px 7px 8px',
                      fontSize: 11,
                      outline: 'none',
                    }}
                  />
                </div>
              ))}
            </div>
          )}
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
            isDark={isDark}
            isPixel={isPixel}
            title="上游素材 · FAL 输入"
          />
          {(activeTool.userParams || []).length > 0 && (
            <div className="space-y-2 rounded-lg p-2" style={{ background: surface, border: `1px solid ${border}` }}>
              <div className="flex items-center gap-1 text-[11px] font-bold" style={{ color: text }}>
                <Layers size={12} /> 参数
              </div>
              {(activeTool.userParams || []).map(renderUserParam)}
            </div>
          )}

          {isBusy ? (
            <button type="button" onClick={handleStop} className="nodrag w-full flex items-center justify-center gap-1.5 rounded py-2 text-xs font-bold" style={{ background: surface, color: text, border: `1px solid ${border}` }}>
              <Square size={12} /> 停止
            </button>
          ) : (
            <button type="button" onClick={() => requestCanvasNodeRun(id)} className="nodrag w-full flex items-center justify-center gap-1.5 rounded py-2 text-xs font-bold" style={{ background: accent, color: isPixel ? 'var(--px-surface)' : '#120818', border: `1px solid ${accent}` }}>
              <Play size={12} fill="currentColor" /> 运行 FAL
            </button>
          )}

          {progressMessage && (
            <div className="flex items-center gap-1 text-[10px]" style={{ color: accent }}>
              {isBusy && <Loader2 size={11} className="animate-spin" />}
              <span className="flex-1">{progressMessage}</span>
              {d.requestId && <span style={{ color: subText }}>{String(d.requestId).slice(0, 10)}...</span>}
            </div>
          )}

          {d.error && (
            <div className="flex items-start gap-1 rounded px-2 py-1 text-[10px]" style={{ color: errorText, background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.35)' }}>
              <AlertCircle size={11} className="mt-0.5 shrink-0" />
              <span className="break-all">{d.error}</span>
            </div>
          )}

          {!hasAutoOutput && (imageUrls.length > 0 || videoUrls.length > 0 || audioUrls.length > 0 || modelUrls.length > 0 || outputText) && (
            <div className="space-y-2 pt-2" style={{ borderTop: `1px solid ${border}` }}>
              {imageUrls.map((url, index) => <SmartImage key={`${url}-${index}`} src={url} alt="Fal超市输出" className="w-full rounded object-contain" thumbSize={720} />)}
              {videoUrls.map((url, index) => <LoopingVideo key={`${url}-${index}`} src={url} controls className="w-full rounded" />)}
              {audioUrls.map((url, index) => <audio key={`${url}-${index}`} src={url} controls className="w-full h-8" />)}
              {modelUrls.map((url, index) => (
                <a
                  key={`${url}-${index}`}
                  href={url}
                  target="_blank"
                  rel="noreferrer"
                  className="nodrag flex items-center gap-2 rounded px-2 py-2 text-[11px]"
                  style={{ background: surface, border: `1px solid ${border}`, color: text }}
                >
                  <Box size={13} style={{ color: accent }} />
                  <span className="flex-1 truncate">3D 模型 {index + 1}</span>
                </a>
              ))}
              {outputText && <div className="rounded p-2 text-[11px] whitespace-pre-wrap" style={{ background: surface, border: `1px solid ${border}`, color: text }}>{outputText}</div>}
              {urls.length > 0 && <div className="text-[10px]" style={{ color: subText }}>输出 {urls.length} 个文件</div>}
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="relative flex flex-col" style={rootStyle}>
      <Handle type="target" position={Position.Left} className="!border-0" style={{ ...handleStyle, background: PORT_COLOR.any, left: -6 }} />
      <Handle type="source" position={Position.Right} className="!border-0" style={{ ...handleStyle, background: PORT_COLOR.any, right: -6 }} />
      <ResizableCorners
        selected={selected}
        minWidth={320}
        minHeight={360}
        accent={String(accent)}
        onResize={onResize}
        onResizeEnd={onResize}
      />
      <div className="flex-1 flex flex-col min-h-0 overflow-hidden" style={{ borderRadius: isPixel ? 6 : 12 }}>
        {renderHeader()}
        {activeToolId ? renderRunner() : renderLauncher()}
      </div>
    </div>
  );
};

export default memo(FalToolboxNode);
