import { memo, useCallback, useEffect, useMemo } from 'react';
import { Handle, Position, useNodeConnections, useNodesData, useReactFlow, type Edge, type Node, type NodeProps } from '@xyflow/react';
import { GitBranch, Shuffle } from 'lucide-react';
import { useRunTrigger } from '../../hooks/useRunTrigger';
import { matchesRunCompletion, useRunBusStore } from '../../stores/runBus';
import { useThemeStore } from '../../stores/theme';
import { PORT_COLOR } from '../../config/portTypes';
import {
  createRandomRouteExecutionSubgraph,
  excludeRandomRouteBranchDescendants,
  normalizeRandomRouteSettings,
  RANDOM_ROUTE_MAX_OUTPUTS,
  RANDOM_ROUTE_MIN_OUTPUTS,
  type RandomRouteExecutionMode,
  randomRouteOutputHandle,
  selectRandomRouteHandles,
} from '../../utils/randomRoute';
import { topologicalLayers, topologicalSort } from '../../utils/topologicalSort';
import { collectMaterialSetBucketsFromData, valueOfMaterialSetItem } from '../../utils/materialSet';
import { shouldCollectNodeTextOutput } from '../../utils/imageNodeOutputMode';
import { useUpdateNodeData } from './useUpdateNodeData';

const COLOR = '#f97316';
const ACTIVE_COLOR = '#22c55e';
const INACTIVE_COLOR = '#64748b';
const WAIT_TIMEOUT_MS = 60 * 60 * 1000;

const EXEC_TYPES = new Set<string>([
  'image', 'edit',
  'multi-angle-3d', 'panorama-720', 'penguin-portrait',
  'video', 'seedance', 'audio', 'llm', 'runninghub', 'runninghub-wallet',
  'rh-tools', 'rh-toolbox', 'fal-toolbox', 'comfyui-store',
  'grok-oauth-agent', 'codex-cli-agent', 'codex-image-conjure',
  'resize', 'upscale', 'grid-crop', 'grid-editor', 'remove-bg', 'combine', 'image-compare', 'drawing-board',
  'panorama-3d',
  'frame-extractor', 'frame-pair',
  'upload',
  'loop', 'pick-from-set', 'random-route',
  'cinematic', 'video-motion', 'multi-angle-visual', 'portrait-master', 'pose-master', 'aggregate-parser', 'batch-processor', 'batch-tagger',
  'topaz-image-upscale', 'topaz-video-upscale',
  'remove-ai-watermark',
]);

type WaitResult = 'ok' | 'fail' | 'cancelled';

const pushUnique = (arr: string[], value: any) => {
  if (typeof value !== 'string') return;
  const trimmed = value.trim();
  if (!trimmed) return;
  if (!arr.includes(trimmed)) arr.push(trimmed);
};

function waitForNodeRun(nodeId: string): Promise<WaitResult> {
  return new Promise((resolve) => {
    let done = false;
    const startCancelSeq = useRunBusStore.getState().cancelSeq;
    let executionToken: string | null = null;
    const finish = (result: WaitResult) => {
      if (done) return;
      done = true;
      unsubscribe();
      window.clearTimeout(timer);
      resolve(result);
    };
    const unsubscribe = useRunBusStore.subscribe((state) => {
      if (state.cancelSeq !== startCancelSeq) finish('cancelled');
      else if (matchesRunCompletion(state.lastDone, nodeId, executionToken)) finish(state.lastDone.ok ? 'ok' : 'fail');
      else if (executionToken && state.executionTokens[nodeId] !== executionToken) finish('cancelled');
    });
    const timer = window.setTimeout(() => finish('fail'), WAIT_TIMEOUT_MS);
    const state = useRunBusStore.getState();
    executionToken = state.triggerRun(nodeId, state.mode === 'batch' ? 'batch' : 'single');
    const current = useRunBusStore.getState();
    if (current.cancelSeq !== startCancelSeq) finish('cancelled');
    else if (matchesRunCompletion(current.lastDone, nodeId, executionToken)) finish(current.lastDone.ok ? 'ok' : 'fail');
    else if (current.executionTokens[nodeId] !== executionToken) finish('cancelled');
  });
}

function routeSubgraphOrder(routeId: string, activeHandles: string[], nodes: Node[], edges: Edge[]) {
  const subgraph = createRandomRouteExecutionSubgraph({ routeId, activeHandles, nodes, edges });
  const pruned = excludeRandomRouteBranchDescendants(subgraph.nodes, subgraph.edges);
  return topologicalSort(pruned.nodes, pruned.edges, EXEC_TYPES);
}

function routeSubgraphLayers(routeId: string, activeHandles: string[], nodes: Node[], edges: Edge[]) {
  const subgraph = createRandomRouteExecutionSubgraph({ routeId, activeHandles, nodes, edges });
  const pruned = excludeRandomRouteBranchDescendants(subgraph.nodes, subgraph.edges);
  return topologicalLayers(pruned.nodes, pruned.edges, EXEC_TYPES);
}

const RandomRouteNode = (p: NodeProps) => {
  const { getEdges, getNodes } = useReactFlow();
  const update = useUpdateNodeData(p.id);
  const { theme, style } = useThemeStore();
  const d = (p.data || {}) as any;
  const settings = normalizeRandomRouteSettings(d);
  const upstreamConnections = useNodeConnections({ id: p.id, handleType: 'target' });
  const upstreamIds = useMemo(
    () => Array.from(new Set(upstreamConnections.map((connection) => connection.source))),
    [upstreamConnections],
  );
  const upstreamNodes = useNodesData(upstreamIds);

  const activeHandles = useMemo(() => {
    const raw = Array.isArray(d.randomRouteActiveHandles) ? d.randomRouteActiveHandles : [];
    return raw.filter((handle: any) => typeof handle === 'string');
  }, [d.randomRouteActiveHandles]);
  const activeSet = useMemo(() => new Set(activeHandles), [activeHandles]);

  const upstreamSignature = useMemo(() => {
    const list = Array.isArray(upstreamNodes) ? upstreamNodes : [];
    return list
      .map((node) => {
        const uid = node?.id || '';
        const data = ((node?.data || {}) as Record<string, any>);
        const arraySignature = (key: string) => (Array.isArray(data[key]) ? JSON.stringify(data[key]) : '');
        return [
          uid,
          node?.type || '',
          data.prompt || '',
          data.outputText || '',
          data.reply || '',
          data.text || '',
          data.imageOnlyOutput === false ? 'image-text-output' : 'image-only-output',
          data.materialSetKind || '',
          data.imageUrl || '',
          data.videoUrl || '',
          data.audioUrl || '',
          data.modelUrl || '',
          arraySignature('imageUrls'),
          arraySignature('videoUrls'),
          arraySignature('audioUrls'),
          arraySignature('modelUrls'),
          arraySignature('textSegments'),
          arraySignature('segments'),
          arraySignature('texts'),
          arraySignature('materialSetItems'),
          arraySignature('urls'),
          arraySignature('generatedImages'),
        ].join('|');
      })
      .join('::');
  }, [upstreamNodes]);

  useEffect(() => {
    const nodes = Array.isArray(upstreamNodes) ? upstreamNodes : [];

    if (upstreamIds.length === 0) {
      const cur = JSON.stringify({
        prompt: d.prompt,
        text: d.text,
        outputText: d.outputText,
        textSegments: d.textSegments,
        segments: d.segments,
        texts: d.texts,
        imageUrl: d.imageUrl,
        imageUrls: d.imageUrls,
        urls: d.urls,
        videoUrl: d.videoUrl,
        videoUrls: d.videoUrls,
        audioUrl: d.audioUrl,
        audioUrls: d.audioUrls,
        modelUrl: d.modelUrl,
        modelUrls: d.modelUrls,
      });
      const empty = JSON.stringify({});
      if (cur !== empty) {
        update({
          prompt: undefined,
          text: undefined,
          outputText: undefined,
          textSegments: undefined,
          segments: undefined,
          texts: undefined,
          imageUrl: undefined,
          imageUrls: undefined,
          urls: undefined,
          videoUrl: undefined,
          videoUrls: undefined,
          audioUrl: undefined,
          audioUrls: undefined,
          modelUrl: undefined,
          modelUrls: undefined,
        });
      }
      return;
    }

    const texts: string[] = [];
    const images: string[] = [];
    const videos: string[] = [];
    const audios: string[] = [];
    const models: string[] = [];

    for (const upstreamId of upstreamIds) {
      const upstreamNode = nodes.find((item) => item.id === upstreamId);
      const data = ((upstreamNode?.data || {}) as Record<string, any>);

      if (upstreamNode?.type === 'material-set' && Array.isArray(data.materialSetItems)) {
        const buckets = collectMaterialSetBucketsFromData(data);
        buckets.text.forEach((item) => pushUnique(texts, valueOfMaterialSetItem(item)));
        buckets.image.forEach((item) => pushUnique(images, item.url));
        buckets.video.forEach((item) => pushUnique(videos, item.url));
        buckets.audio.forEach((item) => pushUnique(audios, item.url));
        continue;
      }

      if (shouldCollectNodeTextOutput(upstreamNode?.type, upstreamNode?.data)) {
        const textArrayField = ['textSegments', 'segments', 'texts'].find((field) => Array.isArray(data[field]) && data[field].length > 0);
        if (textArrayField) data[textArrayField].forEach((text: any) => pushUnique(texts, text));
        else {
          pushUnique(texts, data.outputText);
          pushUnique(texts, data.reply);
          pushUnique(texts, data.prompt);
          pushUnique(texts, data.text);
        }
      }

      pushUnique(images, data.imageUrl);
      for (const key of ['imageUrls', 'urls', 'generatedImages'] as const) {
        if (Array.isArray(data[key])) data[key].forEach((url: any) => pushUnique(images, url));
      }

      pushUnique(videos, data.videoUrl);
      if (Array.isArray(data.videoUrls)) data.videoUrls.forEach((url: any) => pushUnique(videos, url));

      pushUnique(audios, data.audioUrl);
      pushUnique(audios, data.audioUrl_1);
      if (Array.isArray(data.audioUrls)) data.audioUrls.forEach((url: any) => pushUnique(audios, url));

      pushUnique(models, data.modelUrl);
      if (Array.isArray(data.modelUrls)) data.modelUrls.forEach((url: any) => pushUnique(models, url));
      if (Array.isArray(data.directModelUrls)) data.directModelUrls.forEach((url: any) => pushUnique(models, url));
    }

    const prompt = texts.join('\n');
    const merged = {
      prompt: prompt || undefined,
      text: prompt || undefined,
      outputText: prompt || undefined,
      textSegments: texts.length ? texts : undefined,
      segments: texts.length ? texts : undefined,
      texts: texts.length ? texts : undefined,
      imageUrl: images[0],
      imageUrls: images.length > 1 ? images : undefined,
      urls: images.length > 1 ? images : undefined,
      videoUrl: videos[0],
      videoUrls: videos.length > 1 ? videos : undefined,
      audioUrl: audios[0],
      audioUrls: audios.length > 1 ? audios : undefined,
      modelUrl: models[0],
      modelUrls: models.length > 1 ? models : undefined,
    };

    const cur = JSON.stringify({
      prompt: d.prompt,
      text: d.text,
      outputText: d.outputText,
      textSegments: d.textSegments,
      segments: d.segments,
      texts: d.texts,
      imageUrl: d.imageUrl,
      imageUrls: d.imageUrls,
      urls: d.urls,
      videoUrl: d.videoUrl,
      videoUrls: d.videoUrls,
      audioUrl: d.audioUrl,
      audioUrls: d.audioUrls,
      modelUrl: d.modelUrl,
      modelUrls: d.modelUrls,
    });
    const next = JSON.stringify(merged);
    if (cur !== next) update(merged);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [upstreamSignature]);

  const updateSettings = useCallback(
    (patch: Record<string, any>) => {
      const next = normalizeRandomRouteSettings({ ...d, ...patch });
      update({
        randomRouteTotalOutputs: next.totalOutputs,
        randomRoutePassCount: next.randomPassCount,
        randomRouteExecutionMode: next.executionMode,
      });
    },
    [d, update],
  );

  const handleRun = useCallback(async () => {
    const normalized = normalizeRandomRouteSettings(d);
    const selectedHandles = selectRandomRouteHandles(normalized.totalOutputs, normalized.randomPassCount);
    const runAt = Date.now();
    update({
      randomRouteTotalOutputs: normalized.totalOutputs,
      randomRoutePassCount: normalized.randomPassCount,
      randomRouteExecutionMode: normalized.executionMode,
      randomRouteActiveHandles: selectedHandles,
      randomRouteLastRunAt: runAt,
      randomRouteLastOrder: [],
      randomRouteLastOkCount: 0,
      randomRouteLastFailCount: 0,
      status: 'generating',
      error: '',
    });

    const currentNodes = getNodes().map((node) =>
      node.id === p.id
        ? {
            ...node,
            data: {
              ...(node.data || {}),
              randomRouteActiveHandles: selectedHandles,
              randomRouteLastRunAt: runAt,
            },
          }
        : node,
    );
    const currentEdges = getEdges();
    const layers = normalized.executionMode === 'parallel'
      ? routeSubgraphLayers(p.id, selectedHandles, currentNodes, currentEdges)
      : routeSubgraphOrder(p.id, selectedHandles, currentNodes, currentEdges).map((nodeId) => [nodeId]);
    const order = layers.flat();
    let okCount = 0;
    let failCount = 0;

    for (const layer of layers) {
      const results = normalized.executionMode === 'parallel'
        ? await Promise.all(layer.map((nodeId) => waitForNodeRun(nodeId)))
        : [await waitForNodeRun(layer[0])];
      if (results.includes('cancelled')) {
        update({
          randomRouteLastOrder: order,
          randomRouteLastOkCount: okCount,
          randomRouteLastFailCount: failCount,
          status: 'idle',
          error: '已停止随机路由执行。',
        });
        return;
      }
      for (const result of results) {
        if (result === 'ok') okCount += 1;
        else failCount += 1;
      }
    }

    update({
      randomRouteLastOrder: order,
      randomRouteLastOkCount: okCount,
      randomRouteLastFailCount: failCount,
      status: failCount > 0 && okCount === 0 && order.length > 0 ? 'error' : 'success',
      error: failCount > 0 ? `随机路由完成，其中 ${failCount} 个下游节点失败。` : '',
    });
  }, [d, getEdges, getNodes, p.id, update]);

  useRunTrigger(p.id, handleRun, 'random-route');

  const upstreamCount = upstreamConnections.length;
  const downstreamCount = getEdges().filter((edge) => edge.source === p.id).length;
  const textCount = Array.isArray(d.textSegments) ? d.textSegments.length : d.prompt ? 1 : 0;
  const imageCount = (d.imageUrl ? 1 : 0) + (Array.isArray(d.imageUrls) ? d.imageUrls.length : 0);
  const videoCount = (d.videoUrl ? 1 : 0) + (Array.isArray(d.videoUrls) ? d.videoUrls.length : 0);
  const audioCount = (d.audioUrl ? 1 : 0) + (Array.isArray(d.audioUrls) ? d.audioUrls.length : 0);
  const modelCount = (d.modelUrl ? 1 : 0) + (Array.isArray(d.modelUrls) ? d.modelUrls.length : 0);
  const status = String(d.status || 'idle');
  const compactRows = settings.totalOutputs > 60;
  const rowHeight = compactRows ? 16 : 18;
  const lastOrder = Array.isArray(d.randomRouteLastOrder) ? d.randomRouteLastOrder : [];
  const isLightSurface = theme === 'light' || style === 'pixel';
  const textPrimary = isLightSurface ? '#1f2937' : '#f8fafc';
  const textMuted = isLightSurface ? 'rgba(31,41,55,0.62)' : 'rgba(255,255,255,0.55)';
  const textSoft = isLightSurface ? 'rgba(31,41,55,0.78)' : 'rgba(255,255,255,0.72)';
  const panelBg = isLightSurface ? 'rgba(255, 251, 242, 0.98)' : 'rgba(18, 24, 30, 0.94)';
  const sectionBg = isLightSurface ? 'rgba(255, 247, 237, 0.72)' : 'rgba(0, 0, 0, 0.18)';
  const lineColor = isLightSurface ? 'rgba(31,41,55,0.18)' : 'rgba(255,255,255,0.1)';
  const inputBg = isLightSurface ? 'rgba(255,255,255,0.82)' : 'rgba(0,0,0,0.25)';
  const inactiveOutputText = isLightSurface ? 'rgba(51,65,85,0.8)' : 'rgba(255,255,255,0.52)';

  const containerStyle: React.CSSProperties = {
    width: 286,
    background: panelBg,
    border: `2px solid ${p.selected ? COLOR : isLightSurface ? 'rgba(31,41,55,0.72)' : 'rgba(249,115,22,0.42)'}`,
    borderRadius: 10,
    boxShadow: p.selected
      ? `0 0 0 1px ${COLOR}, 0 18px 40px rgba(249,115,22,0.18)`
      : isLightSurface ? '3px 3px 0 rgba(31,41,55,0.85)' : '0 10px 28px rgba(0,0,0,0.32)',
    color: textPrimary,
    backdropFilter: 'blur(8px)',
  };
  const inputClass = 'nodrag nopan w-full rounded border px-2 py-1 text-right text-[11px] font-semibold outline-none';

  return (
    <div
      data-random-route-node
      data-output-count={settings.totalOutputs}
      data-random-pass-count={settings.randomPassCount}
      className="relative overflow-visible"
      style={containerStyle}
    >
      <Handle
        id="input_data"
        type="target"
        position={Position.Left}
        style={{ background: PORT_COLOR.any, border: 0, width: 9, height: 9, top: 82 }}
      />

      <div className="flex items-center gap-2 border-b px-3 py-2" style={{ borderColor: lineColor }}>
        <div
          className="flex h-7 w-7 items-center justify-center rounded"
          style={{ color: '#fed7aa', background: 'rgba(249,115,22,0.18)', boxShadow: `inset 0 0 0 1px ${COLOR}` }}
        >
          <Shuffle size={15} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-black" style={{ color: textPrimary }}>随机路由</div>
          <div className="truncate text-[10px]" style={{ color: textMuted }}>{upstreamCount} 输入 · {downstreamCount} 连线</div>
        </div>
        <div
          className="rounded px-2 py-1 text-[10px] font-black"
          style={{
            color: status === 'generating' ? '#fde68a' : activeHandles.length ? '#bbf7d0' : '#fed7aa',
            background: status === 'generating' ? 'rgba(234,179,8,0.18)' : activeHandles.length ? 'rgba(34,197,94,0.16)' : 'rgba(249,115,22,0.14)',
          }}
        >
          {status === 'generating' ? '运行中' : activeHandles.length ? `${activeHandles.length} 命中` : '待运行'}
        </div>
      </div>

      <div className="space-y-2 px-3 py-3">
        <div className="grid grid-cols-2 gap-2">
          <label className="block text-[10px] font-bold" style={{ color: textMuted }}>
            total_outputs
            <input
              className={inputClass}
              style={{ borderColor: 'rgba(249,115,22,0.45)', background: inputBg, color: textPrimary }}
              type="number"
              min={RANDOM_ROUTE_MIN_OUTPUTS}
              max={RANDOM_ROUTE_MAX_OUTPUTS}
              step={1}
              value={settings.totalOutputs}
              onPointerDown={(event) => event.stopPropagation()}
              onMouseDown={(event) => event.stopPropagation()}
              onChange={(event) => updateSettings({ randomRouteTotalOutputs: event.target.value })}
            />
          </label>
          <label className="block text-[10px] font-bold" style={{ color: textMuted }}>
            random_pass_count
            <input
              className={inputClass}
              style={{ borderColor: 'rgba(34,197,94,0.45)', background: inputBg, color: textPrimary }}
              type="number"
              min={1}
              max={settings.totalOutputs}
              step={1}
              value={settings.randomPassCount}
              onPointerDown={(event) => event.stopPropagation()}
              onMouseDown={(event) => event.stopPropagation()}
              onChange={(event) => updateSettings({ randomRoutePassCount: event.target.value })}
            />
          </label>
        </div>

        <div className="grid grid-cols-5 gap-1 text-center text-[10px] font-bold text-white/55">
          <div className="rounded bg-sky-300/10 py-1" style={{ color: PORT_COLOR.text }}>T {textCount}</div>
          <div className="rounded bg-amber-300/10 py-1" style={{ color: PORT_COLOR.image }}>I {imageCount}</div>
          <div className="rounded bg-rose-300/10 py-1" style={{ color: PORT_COLOR.video }}>V {videoCount}</div>
          <div className="rounded bg-violet-300/10 py-1" style={{ color: PORT_COLOR.audio }}>A {audioCount}</div>
          <div className="rounded bg-blue-300/10 py-1" style={{ color: PORT_COLOR.model3d }}>3D {modelCount}</div>
        </div>

        <label className="block text-[10px] font-bold" style={{ color: textMuted }}>
          运行方式
          <select
            className="nodrag nopan mt-1 w-full rounded border px-2 py-1 text-[11px] font-semibold outline-none"
            style={{ borderColor: 'rgba(249,115,22,0.35)', background: inputBg, color: textPrimary }}
            value={settings.executionMode}
            onPointerDown={(event) => event.stopPropagation()}
            onMouseDown={(event) => event.stopPropagation()}
            onChange={(event) => updateSettings({ randomRouteExecutionMode: event.target.value as RandomRouteExecutionMode })}
          >
            <option value="parallel" style={{ background: panelBg, color: textPrimary }}>并发生成</option>
            <option value="serial" style={{ background: panelBg, color: textPrimary }}>顺序生成</option>
          </select>
        </label>

        <div className="rounded border px-2 py-1.5 text-[10px]" style={{ borderColor: lineColor, background: sectionBg, color: textMuted }}>
          <div className="flex items-center gap-1 font-bold" style={{ color: textSoft }}>
            <GitBranch size={11} />
            <span>上次路由</span>
          </div>
          <div className="mt-1 truncate">
            {activeHandles.length ? activeHandles.join(' / ') : '未运行'}
            {lastOrder.length ? ` · ${lastOrder.length} 节点` : ''}
          </div>
        </div>
      </div>

      <div className="border-t px-3 pb-3 pt-2" style={{ borderColor: lineColor }}>
        <div className="mb-1 flex items-center justify-between text-[10px] font-bold" style={{ color: textMuted }}>
          <span>outputs</span>
          <span>{settings.randomPassCount}/{settings.totalOutputs}</span>
        </div>
        <div className="space-y-[1px]">
          {Array.from({ length: settings.totalOutputs }, (_, index) => {
            const handle = randomRouteOutputHandle(index + 1);
            const active = activeSet.has(handle);
            return (
              <div
                key={handle}
                data-random-route-output-handle={handle}
                data-active={active ? 'true' : 'false'}
                className="relative flex items-center justify-end gap-2 rounded px-1 text-[10px] font-semibold"
                style={{
                  height: rowHeight,
                  color: active ? (isLightSurface ? '#15803d' : '#bbf7d0') : inactiveOutputText,
                  background: active ? 'rgba(34,197,94,0.12)' : 'transparent',
                }}
              >
                <span>{handle}</span>
                <span
                  style={{
                    width: 5,
                    height: 5,
                    borderRadius: 999,
                    background: active ? ACTIVE_COLOR : INACTIVE_COLOR,
                    opacity: active ? 1 : 0.65,
                  }}
                />
                <Handle
                  type="source"
                  id={handle}
                  position={Position.Right}
                  style={{
                    top: '50%',
                    right: -7,
                    transform: 'translateY(-50%)',
                    background: active ? ACTIVE_COLOR : INACTIVE_COLOR,
                    border: 0,
                    width: active ? 9 : 7,
                    height: active ? 9 : 7,
                  }}
                />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

export default memo(RandomRouteNode);
