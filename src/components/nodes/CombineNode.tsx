import { memo, useState, useCallback } from 'react';
import { Handle, Position, useReactFlow, type NodeProps } from '@xyflow/react';
import { AlertCircle, Loader2, Sparkles, Combine } from 'lucide-react';
import { useUpdateNodeData } from './useUpdateNodeData';
import { opCombine } from '../../services/imageOps';
import { useRunTrigger } from '../../hooks/useRunTrigger';
import { requestCanvasNodeRun } from '../../utils/canvasRunRequest';
import { useHasAutoOutput } from './useHasAutoOutput';
import SmartImage from '../SmartImage';

/**
 * CombineNode - 多图拼接(横向/纵向)
 * 需要至少 2 张上游图像
 */
const COLOR = '#fb923c';

const CombineNode = (p: NodeProps) => {
  const update = useUpdateNodeData(p.id);
  const { getEdges, getNodes } = useReactFlow();
  const hasAutoOutput = useHasAutoOutput(p.id);
  const [error, setError] = useState<string | null>(null);
  const d = p.data as any;
  const direction: 'horizontal' | 'vertical' = d?.direction || 'horizontal';
  const status: 'idle' | 'running' | 'success' | 'error' = d?.status || 'idle';
  const outImg: string | undefined = d?.imageUrl;

  const collectUpstreamImages = useCallback((): string[] => {
    const edges = getEdges();
    const nodes = getNodes();
    const upstreamIds = edges.filter((e) => e.target === p.id).map((e) => e.source);
    const urls: string[] = [];
    for (const uid of upstreamIds) {
      const n = nodes.find((x) => x.id === uid);
      const u = (n?.data as any)?.imageUrl;
      if (u && typeof u === 'string') urls.push(u);
      const us = (n?.data as any)?.urls;
      if (Array.isArray(us)) urls.push(...us.filter((x) => typeof x === 'string'));
    }
    return urls;
  }, [getEdges, getNodes, p.id]);

  const handleRun = async () => {
    setError(null);
    const imgs = collectUpstreamImages();
    if (imgs.length < 2) {
      setError('至少需要 2 张上游图像');
      return;
    }
    update({ status: 'running', error: null });
    try {
      const r = await opCombine(imgs, direction);
      update({ status: 'success', imageUrl: r.imageUrl });
    } catch (e: any) {
      setError(e?.message || '拼接失败');
      update({ status: 'error', error: e?.message });
    }
  };

  // 接入运行总线,供批量运行调起
  useRunTrigger(p.id, handleRun);

  return (
    <div
      className={`relative rounded-xl border-2 transition-all ${
        p.selected ? 'shadow-2xl' : 'border-white/15 hover:border-white/30'
      }`}
      style={{
        background: 'rgba(20,20,22,.92)',
        backdropFilter: 'blur(8px)',
        width: 260,
        borderColor: p.selected ? COLOR : undefined,
        boxShadow: p.selected ? `0 0 0 1px ${COLOR}, 0 16px 32px rgba(251,146,60,.2)` : undefined,
      }}
    >
      <Handle type="target" position={Position.Left} style={{ background: COLOR, border: 0 }} />
      <Handle type="source" position={Position.Right} style={{ background: COLOR, border: 0 }} />

      <div className="flex items-center gap-2 px-3 py-2 border-b border-white/10">
        <div
          className="w-6 h-6 rounded flex items-center justify-center"
          style={{ background: 'rgba(251,146,60,.2)', color: '#fed7aa', boxShadow: `inset 0 0 0 1px ${COLOR}` }}
        >
          <Combine size={13} />
        </div>
        <div className="flex-1">
          <div className="text-sm font-semibold text-white">图像拼接</div>
          <div className="text-[10px] text-white/40">{direction === 'horizontal' ? '横向' : '纵向'}</div>
        </div>
      </div>

      <div className="p-2.5 space-y-2" onMouseDown={(e) => e.stopPropagation()}>
        <div>
          <label className="text-[10px] text-white/50 block mb-1">方向</label>
          <div className="grid grid-cols-2 gap-1.5">
            {(['horizontal', 'vertical'] as const).map((m) => (
              <button
                key={m}
                onClick={() => update({ direction: m })}
                className={`py-1 rounded text-[11px] transition-colors ${
                  direction === m
                    ? 'bg-orange-500/30 text-orange-100 border border-orange-400/40'
                    : 'bg-white/5 text-white/60 border border-white/10 hover:bg-white/10'
                }`}
              >
                {m === 'horizontal' ? '横向' : '纵向'}
              </button>
            ))}
          </div>
        </div>

        <button
          onClick={() => requestCanvasNodeRun(p.id)}
          disabled={status === 'running'}
          className="w-full flex items-center justify-center gap-1.5 py-1.5 rounded text-xs font-medium disabled:opacity-50 transition-colors bg-orange-500/20 hover:bg-orange-500/30 text-orange-200"
        >
          {status === 'running' ? (
            <>
              <Loader2 size={11} className="animate-spin" /> 处理中...
            </>
          ) : (
            <>
              <Sparkles size={11} /> 拼接
            </>
          )}
        </button>

        {error && (
          <div className="flex items-start gap-1 text-[10px] text-red-300 bg-red-500/10 border border-red-500/20 rounded px-2 py-1">
            <AlertCircle size={11} className="mt-0.5 flex-shrink-0" />
            <span className="break-all">{error}</span>
          </div>
        )}
      </div>

      {outImg && !hasAutoOutput && (
        <div className="border-t border-white/10 p-2">
          <SmartImage src={outImg} alt="结果" className="w-full rounded object-contain" thumbSize={720} />
        </div>
      )}
    </div>
  );
};

export default memo(CombineNode);
