import { memo, useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { Handle, Position, useNodeConnections, useNodesData, type NodeProps } from '@xyflow/react';
import { AlertCircle, GitCompare, Loader2, Sparkles } from 'lucide-react';
import { useUpdateNodeData } from './useUpdateNodeData';
import { useRunTrigger } from '../../hooks/useRunTrigger';
import { requestCanvasNodeRun } from '../../utils/canvasRunRequest';
import { useHasAutoOutput } from './useHasAutoOutput';
import { opCompare, uploadDataUrl } from '../../services/imageOps';
import ImageCompareStage from '../ImageCompareStage';
import {
  ALIGN_OPTIONS,
  MODE_OPTIONS,
  extractImagesFromData,
  getImageCompareStats,
  renderCompareDataUrl,
  type AlignMode,
  type CompareMode,
  type CompareStats,
} from '../../utils/imageCompare';

/**
 * ImageCompareNode - 图像对比
 *
 * 默认连接 2 张图后直接在节点内预览；点击运行时由后端生成一张静态对比结果图，
 * 写入 data.imageUrl，继续交给下游 OutputNode / 资源库 / 导出链路使用。
 */
const COLOR = '#fb923c';

const ImageCompareNode = (p: NodeProps) => {
  const update = useUpdateNodeData(p.id);
  const hasAutoOutput = useHasAutoOutput(p.id);
  const conns = useNodeConnections({ id: p.id, handleType: 'target' });
  const upstreamIds = useMemo(() => Array.from(new Set(conns.map((c) => c.source))), [conns]);
  const upstreamNodes = useNodesData(upstreamIds);
  const d = (p.data as any) || {};

  const mode: CompareMode = d.mode === 'checker' ? 'focus' : (d.mode || 'slider');
  const align: AlignMode = d.align || 'contain';
  const split = Math.max(0, Math.min(100, Number(d.split ?? 50)));
  const opacity = Math.max(0, Math.min(100, Number(d.opacity ?? 50)));
  const threshold = Math.max(0, Math.min(255, Number(d.threshold ?? 24)));
  const status: 'idle' | 'running' | 'success' | 'error' = d.status || 'idle';
  const outputUrl: string = d.imageUrl || '';

  const [error, setError] = useState<string | null>(d.error || null);
  const [stats, setStats] = useState<CompareStats | null>(null);

  const upstreamSig = useMemo(() => {
    const list = Array.isArray(upstreamNodes) ? upstreamNodes : [];
    return list
      .map((n: any) => {
        const ud = n?.data || {};
        return [
          n?.id || '',
          ud.imageUrl || '',
          Array.isArray(ud.imageUrls) ? ud.imageUrls.join(',') : '',
          Array.isArray(ud.urls) ? ud.urls.join(',') : '',
          Array.isArray(ud.generatedImages) ? ud.generatedImages.join(',') : '',
          ud.firstFrameUrl || '',
          ud.lastFrameUrl || '',
        ].join('§');
      })
      .join('|');
  }, [upstreamNodes]);

  const pair = useMemo(() => {
    const nodeMap = new Map<string, any>();
    const list = Array.isArray(upstreamNodes) ? upstreamNodes : [];
    for (const n of list as any[]) nodeMap.set(n.id, n);

    const aCandidates: string[] = [];
    const bCandidates: string[] = [];
    const autoCandidates: string[] = [];
    const allCandidates: string[] = [];

    for (const c of conns as any[]) {
      const n = nodeMap.get(c.source);
      const imgs = extractImagesFromData(n?.data, c.sourceHandle ?? null);
      for (const img of imgs) {
        if (!allCandidates.includes(img)) allCandidates.push(img);
        if (c.targetHandle === 'a') {
          if (!aCandidates.includes(img)) aCandidates.push(img);
        } else if (c.targetHandle === 'b') {
          if (!bCandidates.includes(img)) bCandidates.push(img);
        } else if (!autoCandidates.includes(img)) {
          autoCandidates.push(img);
        }
      }
    }

    const before = aCandidates[0] || autoCandidates[0] || allCandidates[0] || '';
    const after =
      bCandidates[0] ||
      autoCandidates.find((u) => u !== before) ||
      allCandidates.find((u) => u !== before) ||
      '';
    return { before, after, count: allCandidates.length };
  }, [conns, upstreamNodes, upstreamSig]);

  const before = pair.before;
  const after = pair.after;
  const hasPair = !!before && !!after;

  useEffect(() => {
    let cancelled = false;
    if (!hasPair) {
      setStats(null);
      return;
    }
    getImageCompareStats(before, after, align, threshold)
      .then((next) => {
        if (!cancelled) setStats(next);
      })
      .catch(() => {
        if (!cancelled) setStats(null);
      });
    return () => {
      cancelled = true;
    };
  }, [before, after, align, threshold, hasPair]);

  const handleRun = useCallback(async () => {
    setError(null);
    if (!before || !after) {
      const msg = '请连接 2 张上游图像';
      setError(msg);
      update({ status: 'error', error: msg });
      return;
    }
    update({ status: 'running', error: null });
    try {
      let r: Awaited<ReturnType<typeof opCompare>>;
      try {
        r = await opCompare(before, after, mode, {
          align,
          split,
          opacity,
          threshold,
        });
      } catch (backendError) {
        const dataUrl = await renderCompareDataUrl({ before, after, mode, align, split, opacity, threshold });
        const imageUrl = await uploadDataUrl(dataUrl, 'compare');
        r = {
          imageUrl,
          metrics: {
            width: stats?.imageA.width || 0,
            height: stats?.imageA.height || 0,
            imageA: stats?.imageA || { width: 0, height: 0 },
            imageB: stats?.imageB || { width: 0, height: 0 },
            meanDiff: stats?.meanDiff || 0,
            maxDiff: stats?.maxDiff || 0,
            changedRatio: stats?.changedRatio || 0,
            threshold,
          },
        };
        console.warn('[image-compare] fallback to browser canvas:', backendError);
      }
      update({
        status: 'success',
        imageUrl: r.imageUrl,
        compareMetrics: r.metrics,
        error: null,
      });
    } catch (e: any) {
      const msg = e?.message || '生成对比图失败';
      setError(msg);
      update({ status: 'error', error: msg });
    }
  }, [align, after, before, mode, opacity, split, threshold, update]);

  useRunTrigger(p.id, async () => {
    if (status === 'running') return;
    await handleRun();
  });

  const setMode = (value: CompareMode) => update({ mode: value });
  const setAlign = (value: AlignMode) => update({ align: value });

  const nodeStyle: CSSProperties = {
    width: 380,
    borderColor: p.selected ? COLOR : undefined,
    boxShadow: p.selected ? `0 0 0 2px ${COLOR}, var(--t8-shadow-strong, 0 18px 36px rgba(0,0,0,.22))` : undefined,
  };

  const renderPreview = () => {
    if (!before) {
      return (
        <div className="aspect-video rounded-lg border border-dashed border-[var(--t8-border)] bg-[var(--t8-bg-panel-muted)] flex items-center justify-center text-xs text-[var(--t8-text-dim)]">
          连接第一张图
        </div>
      );
    }
    if (!after) {
      return (
        <div className="space-y-2">
          <div className="aspect-video rounded-lg overflow-hidden bg-[var(--t8-bg-panel-muted)] border border-[var(--t8-border)]">
            <img src={before} alt="原图 A" className="w-full h-full object-contain" draggable={false} />
          </div>
          <div className="text-center text-xs text-[var(--t8-text-dim)]">继续连接第二张图</div>
        </div>
      );
    }

    return (
      <ImageCompareStage
        before={before}
        after={after}
        mode={mode}
        align={align}
        split={split}
        opacity={opacity}
        threshold={threshold}
        labels={['原图', '对比图']}
        className="aspect-video"
      />
    );
  };

  return (
    <div className="t8-node relative transition-all" style={nodeStyle}>
      <Handle id="a" type="target" position={Position.Left} style={{ top: '37%', background: COLOR, border: 0 }} />
      <Handle id="b" type="target" position={Position.Left} style={{ top: '63%', background: COLOR, border: 0 }} />
      <Handle type="source" position={Position.Right} style={{ background: COLOR, border: 0 }} />

      <div className="relative z-10">
        <div className="t8-node-header flex items-center gap-2 px-3 py-2">
          <div
            className="w-7 h-7 rounded-lg flex items-center justify-center"
            style={{ background: 'color-mix(in srgb, var(--t8-accent) 18%, transparent)', color: 'var(--t8-accent)' }}
          >
            <GitCompare size={15} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-bold text-[var(--t8-text-main)]">图像对比</div>
            <div className="text-[10px] text-[var(--t8-text-muted)]">
              {hasPair ? `${MODE_OPTIONS.find((x) => x.value === mode)?.label || '对比'} · ${ALIGN_OPTIONS.find((x) => x.value === align)?.label}` : `已连接 ${pair.count}/2 张图`}
            </div>
          </div>
        </div>

        <div className="p-3 space-y-3 nodrag" onMouseDown={(e) => e.stopPropagation()}>
          {renderPreview()}

          <div className="grid grid-cols-3 gap-1.5">
            {MODE_OPTIONS.map((item) => (
              <button
                key={item.value}
                type="button"
                onClick={() => setMode(item.value)}
                title={item.label}
                className={`t8-btn px-2 py-1.5 text-[11px] ${mode === item.value ? 't8-btn-primary' : ''}`}
              >
                {item.short}
              </button>
            ))}
          </div>

          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <span className="mb-1 block text-[10px] font-bold text-[var(--t8-text-muted)]">对齐</span>
              <select
                value={align}
                onChange={(e) => setAlign(e.target.value as AlignMode)}
                className="t8-select w-full px-2 py-1.5 text-xs"
              >
                {ALIGN_OPTIONS.map((x) => (
                  <option key={x.value} value={x.value}>{x.label}</option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-[10px] font-bold text-[var(--t8-text-muted)]">
                {mode === 'overlay' ? `透明度 ${opacity}%` : (mode === 'heatmap' || mode === 'focus') ? `阈值 ${threshold}` : `分割 ${split}%`}
              </span>
              <input
                type="range"
                min={0}
                max={(mode === 'heatmap' || mode === 'focus') ? 120 : 100}
                value={mode === 'overlay' ? opacity : (mode === 'heatmap' || mode === 'focus') ? threshold : split}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  if (mode === 'overlay') update({ opacity: v });
                  else if (mode === 'heatmap' || mode === 'focus') update({ threshold: v });
                  else update({ split: v });
                }}
                className="w-full accent-orange-400"
              />
            </label>
          </div>

          <div className="grid grid-cols-3 gap-1.5 text-[10px] text-[var(--t8-text-muted)]">
            <div className="rounded-md border border-[var(--t8-border)] bg-[var(--t8-bg-panel-muted)] px-2 py-1">
              原图 {stats ? `${stats.imageA.width}×${stats.imageA.height}` : '--'}
            </div>
            <div className="rounded-md border border-[var(--t8-border)] bg-[var(--t8-bg-panel-muted)] px-2 py-1">
              对比 {stats ? `${stats.imageB.width}×${stats.imageB.height}` : '--'}
            </div>
            <div className="rounded-md border border-[var(--t8-border)] bg-[var(--t8-bg-panel-muted)] px-2 py-1">
              变化 {stats?.changedRatio !== undefined ? `${Math.round(stats.changedRatio * 100)}%` : '--'}
            </div>
          </div>

          <button
            type="button"
            onClick={() => requestCanvasNodeRun(p.id)}
            disabled={status === 'running' || !hasPair}
            className="t8-btn t8-btn-primary w-full px-3 py-2 text-xs disabled:opacity-50"
          >
            {status === 'running' ? (
              <>
                <Loader2 size={13} className="animate-spin" /> 生成中...
              </>
            ) : (
              <>
                <Sparkles size={13} /> 生成对比结果图
              </>
            )}
          </button>

          {mode === 'blink' && (
            <div className="text-[10px] text-[var(--t8-text-dim)]">闪烁模式运行时会导出为并排对比图。</div>
          )}
          {outputUrl && !hasAutoOutput && (
            <div className="rounded-md border border-[var(--t8-border)] bg-[var(--t8-bg-panel-muted)] px-2 py-1 text-[10px] text-[var(--t8-text-muted)]">
              已生成结果，可从右侧端口继续连接输出素材。
            </div>
          )}
          {error && (
            <div className="flex items-start gap-1.5 rounded-md border border-red-500/30 bg-red-500/10 px-2 py-1.5 text-[10px] text-red-300">
              <AlertCircle size={12} className="mt-0.5 flex-shrink-0" />
              <span className="break-all">{error}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default memo(ImageCompareNode);
