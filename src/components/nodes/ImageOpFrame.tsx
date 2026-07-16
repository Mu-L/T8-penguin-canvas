import { memo, useState, type ReactNode } from 'react';
import { Handle, Position, useReactFlow } from '@xyflow/react';
import { AlertCircle, Loader2, Sparkles } from 'lucide-react';
import { useUpdateNodeData } from './useUpdateNodeData';
import { useRunTrigger } from '../../hooks/useRunTrigger';
import { requestCanvasNodeRun } from '../../utils/canvasRunRequest';
import { useHasAutoOutput } from './useHasAutoOutput';
import SmartImage from '../SmartImage';

/**
 * ImageOpNode - 图像变换节点的通用外壳
 * 子节点(resize/upscale 等)只需提供:
 *   title / icon / colorHex / accent / settingsForm / runOp(imageUrl) → { imageUrl } | { urls }
 */
interface ImageOpNodeProps {
  id: string;
  data: any;
  selected?: boolean;
  title: string;
  subtitle?: string;
  icon: ReactNode;
  colorHex: string; // 边框/handle 主色 hex
  bgRgba: string;   // 标头方块底色
  shadowRgba: string;
  textHex: string;  // 标头方块文字色
  buttonClasses: string;
  /** 渲染配置区域 */
  renderSettings: () => ReactNode;
  /** 执行变换,返回单图或多图 */
  runOp: (imageUrl: string) => Promise<{ imageUrl?: string; urls?: string[] }>;
  /** 可选：由节点自行订阅并传入的上游图像列表，避免预览和运行读取不同来源 */
  inputImages?: string[];
  /** 是否把所有上游图像逐张处理并合并输出，适合宫格剪裁批量拆分合集 */
  processAllInputs?: boolean;
  /** 是否需要多张输入(combine) */
  needsMulti?: boolean;
  width?: number;
}

export function ImageOpFrame(props: ImageOpNodeProps) {
  const { id, data, selected, title, subtitle, icon, colorHex, bgRgba, shadowRgba, textHex, buttonClasses, renderSettings, runOp, inputImages, processAllInputs, needsMulti, width } = props;
  const update = useUpdateNodeData(id);
  const { getEdges, getNodes } = useReactFlow();
  const [error, setError] = useState<string | null>(null);
  const d = data as any;
  const status: 'idle' | 'running' | 'success' | 'error' = d?.status || 'idle';
  const outImg: string | undefined = d?.imageUrl;
  const outUrls: string[] = d?.urls || [];
  // 下游已连 OutputNode：隐藏节点内预览，避免占双份垂直空间 + 避免重复展示
  const hasAutoOutput = useHasAutoOutput(id);

  const collectUpstreamImages = (): string[] => {
    const edges = getEdges();
    const nodes = getNodes();
    const upstreamIds = edges.filter((e) => e.target === id).map((e) => e.source);
    const urls: string[] = [];
    const pushImage = (u: any) => {
      if (typeof u !== 'string' || !u) return;
      if (/\.(mp4|webm|mov|m4v|mkv|mp3|wav|ogg|m4a|flac|aac)(\?.*)?$/i.test(u)) return;
      if (!urls.includes(u)) urls.push(u);
    };
    for (const uid of upstreamIds) {
      const n = nodes.find((x) => x.id === uid);
      const d = (n?.data as any) || {};
      pushImage(d.imageUrl);
      if (Array.isArray(d.imageUrls)) d.imageUrls.forEach(pushImage);
      if (Array.isArray(d.urls)) d.urls.forEach(pushImage);
      if (Array.isArray(d.generatedImages)) d.generatedImages.forEach(pushImage);
    }
    return urls;
  };

  const handleRun = async () => {
    setError(null);
    const imgs = inputImages && inputImages.length > 0 ? inputImages : collectUpstreamImages();
    if (imgs.length === 0) {
      setError('未连接上游图像节点');
      return;
    }
    update({ status: 'running', error: null });
    try {
      // 通用约定:子节点处理第一张图；需要批量拆分时逐张处理全部上游图像。
      // combine 节点会自己在 runOp 内 ignore 参数,直接用全部上游。
      const r = processAllInputs && !needsMulti
        ? await (async () => {
            const urls: string[] = [];
            for (const img of imgs) {
              const one = await runOp(img);
              if (one.imageUrl) urls.push(one.imageUrl);
              if (Array.isArray(one.urls)) urls.push(...one.urls);
            }
            return { imageUrl: urls[0], urls };
          })()
        : await runOp(needsMulti ? (imgs as any) : imgs[0]);
      const patch: any = { status: 'success' };
      if (r.imageUrl) patch.imageUrl = r.imageUrl;
      if (r.urls) {
        patch.urls = r.urls;
        patch.imageUrls = r.urls;
        if (!patch.imageUrl && r.urls[0]) patch.imageUrl = r.urls[0];
      }
      update(patch);
    } catch (e: any) {
      setError(e?.message || '处理失败');
      update({ status: 'error', error: e?.message });
    }
  };

  // 接入运行总线,供批量运行调起
  useRunTrigger(id, handleRun);

  return (
    <div
      className={`relative rounded-xl border-2 transition-all ${
        selected ? 'shadow-2xl' : 'border-white/15 hover:border-white/30'
      }`}
      style={{
        background: 'rgba(20,20,22,.92)',
        backdropFilter: 'blur(8px)',
        width: width || 260,
        borderColor: selected ? colorHex : undefined,
        boxShadow: selected ? `0 0 0 1px ${colorHex}, 0 16px 32px ${shadowRgba}` : undefined,
      }}
    >
      <Handle type="target" position={Position.Left} style={{ background: colorHex, border: 0 }} />
      <Handle type="source" position={Position.Right} style={{ background: colorHex, border: 0 }} />

      <div className="flex items-center gap-2 px-3 py-2 border-b border-white/10">
        <div
          className="w-6 h-6 rounded flex items-center justify-center"
          style={{ background: bgRgba, color: textHex, boxShadow: `inset 0 0 0 1px ${colorHex}` }}
        >
          {icon}
        </div>
        <div className="flex-1">
          <div className="text-sm font-semibold text-white">{title}</div>
          {subtitle && <div className="text-[10px] text-white/40">{subtitle}</div>}
        </div>
      </div>

      <div className="p-2.5 space-y-2" onMouseDown={(e) => e.stopPropagation()}>
        {renderSettings()}

        <button
          onClick={() => requestCanvasNodeRun(id)}
          disabled={status === 'running'}
          className={`w-full flex items-center justify-center gap-1.5 py-1.5 rounded text-xs font-medium disabled:opacity-50 transition-colors ${buttonClasses}`}
        >
          {status === 'running' ? (
            <>
              <Loader2 size={11} className="animate-spin" /> 处理中...
            </>
          ) : (
            <>
              <Sparkles size={11} /> 运行
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
      {outUrls.length > 0 && !hasAutoOutput && (
        <div className="border-t border-white/10 p-2 grid grid-cols-3 gap-1">
          {outUrls.map((u, i) => (
            <SmartImage key={i} src={u} alt={`#${i}`} className="w-full rounded object-cover" thumbSize={240} />
          ))}
        </div>
      )}
    </div>
  );
}

export default memo(ImageOpFrame);
