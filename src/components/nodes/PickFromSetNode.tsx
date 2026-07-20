import { memo, useCallback, useMemo, useState } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import {
  AlertCircle,
  Filter,
  ListOrdered,
  Loader2,
  Play,
  Type as TypeIcon,
  Image as ImageIcon,
  Video as VideoIcon,
  Music as AudioIcon,
} from 'lucide-react';
import { useUpdateNodeData } from './useUpdateNodeData';
import { useRunTrigger } from '../../hooks/useRunTrigger';
import { requestCanvasNodeRun } from '../../utils/canvasRunRequest';
import { useThemeStore } from '../../stores/theme';
import { useUpstreamMaterials, type MaterialKind } from './useUpstreamMaterials';
import { PORT_COLOR } from '../../config/portTypes';
import LoopingVideo from '../LoopingVideo';
import SmartImage from '../SmartImage';

/**
 * PickFromSetNode —「从合集获取」工具节点 (v1.2.8 新增)
 *
 * 设计:
 *   1. 输入(左侧 target): text / image / video / audio (任意 4 类聚合)
 *      —— 通常配合 LoopNode 输出的多个 OutputNode 集合使用，
 *         也可直接接到任意暴露多素材的上游(LoopNode 多 OutputNode 集 / AudioNode 双轨 / FramePair 双输出 / etc)。
 *
 *   2. 选择 kind + index (1-based) → 节点根据 useUpstreamMaterials 聚合派生
 *      取出第 index 个素材, 写入自身 data 对应字段 (imageUrl / videoUrl / audioUrl / outputText)
 *      下游通过 useUpstreamMaterials 自动拾取这一条素材, 像普通的 OutputNode 一样使用。
 *
 *   3. 输出端口语义按 kind 切换 (颜色与 PORT_COLOR 一致):
 *      - kind=text  → text  (sky)
 *      - kind=image → image (amber)
 *      - kind=video → video (rose)
 *      - kind=audio → audio (violet)
 *
 *   4. 双主题: pixel(糖果硬阴影) / dark(深色玻璃) / light(浅色玻璃)
 *
 *   5. 接入运行总线: useRunTrigger(id, handlePick) → 批量运行可触发
 */

const COLOR = '#fb923c'; // utility 系一致的 orange-400

const KIND_ICONS: Record<MaterialKind, React.ComponentType<{ size?: number }>> = {
  text: TypeIcon,
  image: ImageIcon,
  video: VideoIcon,
  audio: AudioIcon,
};

const KIND_LABEL: Record<MaterialKind, string> = {
  text: '文本',
  image: '图像',
  video: '视频',
  audio: '音频',
};

const PickFromSetNode = (p: NodeProps) => {
  const update = useUpdateNodeData(p.id);
  const d = (p.data as any) || {};
  const { theme, style } = useThemeStore();
  const isPixel = style === 'pixel';
  const isDark = theme === 'dark';

  const pickKind: MaterialKind = (['text', 'image', 'video', 'audio'] as const).includes(d?.pickKind) ? d.pickKind : 'image';
  const pickIndex: number = typeof d?.pickIndex === 'number' && d.pickIndex >= 1 ? d.pickIndex : 1;
  const status: 'idle' | 'running' | 'success' | 'error' = d?.status || 'idle';
  const [error, setError] = useState<string | null>(d?.error || null);

  // 上游素材聚合
  const upstream = useUpstreamMaterials(p.id);
  const list = useMemo<string[]>(() => {
    const arr = pickKind === 'image' ? upstream.images
      : pickKind === 'video' ? upstream.videos
      : pickKind === 'audio' ? upstream.audios
      : upstream.texts;
    return arr.map((m) => m.url);
  }, [pickKind, upstream]);

  // 当前选中素材 (预览)
  const total = list.length;
  const safeIndex = Math.max(1, Math.min(pickIndex, Math.max(total, 1)));
  const currentValue = total > 0 ? list[safeIndex - 1] : '';

  // ===== 选取主流程 =====
  const handlePick = useCallback(async () => {
    setError(null);
    if (total === 0) {
      const msg = '上游没有可选素材';
      setError(msg);
      update({ status: 'error', error: msg });
      return;
    }
    const idx0 = Math.max(0, Math.min(pickIndex - 1, total - 1));
    const value = list[idx0];
    if (!value) {
      const msg = '索引超出范围';
      setError(msg);
      update({ status: 'error', error: msg });
      return;
    }
    // 写入自身 data —— 下游 useUpstreamMaterials 会自动拾取
    // 写入前清空其他 kind 字段, 避免下游同时拿到旧的产物
    const patch: Record<string, any> = {
      status: 'success',
      error: null,
      pickedKind: pickKind,
      pickedIndex: idx0 + 1,
      pickedValue: value,
      // 清空所有其他 kind 字段
      imageUrl: '',
      imageUrls: [],
      videoUrl: '',
      audioUrl: '',
      outputText: '',
    };
    if (pickKind === 'image') {
      patch.imageUrl = value;
      patch.imageUrls = [value];
    } else if (pickKind === 'video') {
      patch.videoUrl = value;
    } else if (pickKind === 'audio') {
      patch.audioUrl = value;
    } else {
      patch.outputText = value;
    }
    update(patch);
  }, [list, total, pickKind, pickIndex, update]);

  // 接入运行总线
  useRunTrigger(p.id, async () => {
    if (status === 'running') return;
    await handlePick();
  });

  // ===== 双主题 token =====
  const accent = isPixel ? '#C73B6B' : COLOR;
  const containerStyle: React.CSSProperties = isPixel
    ? {
        width: 260,
        background: 'var(--px-surface, #FFFFFF)',
        border: '2px solid var(--px-ink, #1A1410)',
        borderRadius: 0,
        boxShadow: p.selected ? '5px 5px 0 var(--px-ink, #1A1410)' : '3px 3px 0 var(--px-ink, #1A1410)',
        color: 'var(--px-ink, #1A1410)',
      }
    : isDark
    ? {
        width: 260,
        background: 'rgba(20,20,22,.92)',
        backdropFilter: 'blur(8px)',
        border: '2px solid rgba(255,255,255,.15)',
        borderColor: p.selected ? COLOR : undefined,
        borderRadius: 12,
        boxShadow: p.selected ? `0 0 0 1px ${COLOR}, 0 16px 32px rgba(251,146,60,.2)` : undefined,
      }
    : {
        width: 260,
        background: 'rgba(255,255,255,.95)',
        backdropFilter: 'blur(8px)',
        border: '2px solid rgba(0,0,0,.12)',
        borderColor: p.selected ? COLOR : undefined,
        borderRadius: 12,
        boxShadow: p.selected ? `0 0 0 1px ${COLOR}, 0 16px 32px rgba(251,146,60,.18)` : '0 4px 12px rgba(0,0,0,.06)',
      };

  const headerBorder = isPixel
    ? '2px solid var(--px-ink, #1A1410)'
    : isDark
    ? '1px solid rgba(255,255,255,.10)'
    : '1px solid rgba(0,0,0,.08)';

  const titleColor = isPixel ? 'var(--px-ink, #1A1410)' : isDark ? '#fff' : '#111';
  const subColor = isPixel
    ? 'var(--px-ink-soft, #5A4A3F)'
    : isDark
    ? 'rgba(255,255,255,.4)'
    : 'rgba(0,0,0,.45)';

  // 标题色块
  const iconBoxStyle: React.CSSProperties = isPixel
    ? {
        background: 'var(--px-peach, #FFCBA4)',
        border: '1.5px solid var(--px-ink, #1A1410)',
        boxShadow: '1px 1px 0 var(--px-ink, #1A1410)',
        color: 'var(--px-ink, #1A1410)',
      }
    : {
        background: 'rgba(251,146,60,.2)',
        boxShadow: `inset 0 0 0 1px ${COLOR}`,
        color: '#fed7aa',
      };

  const btnClass = isPixel
    ? 'w-full flex items-center justify-center gap-1.5 py-1.5 text-[12px] font-semibold'
    : isDark
    ? 'w-full flex items-center justify-center gap-1.5 py-1.5 rounded text-xs font-medium disabled:opacity-50 transition-colors bg-orange-500/20 hover:bg-orange-500/30 text-orange-200 border border-orange-400/30'
    : 'w-full flex items-center justify-center gap-1.5 py-1.5 rounded text-xs font-medium disabled:opacity-50 transition-colors bg-orange-100 hover:bg-orange-200 text-orange-700 border border-orange-300';

  // v1.2.8.8: pixel 主按钮 inline 样式 (方角 + peach 底色 + 硕阳线边 + 硬阴影)
  const pixelBtnStyle: React.CSSProperties = {
    background: 'var(--px-peach, #FFCBA4)',
    border: '2px solid var(--px-ink, #1A1410)',
    borderRadius: 0,
    boxShadow: '2px 2px 0 var(--px-ink, #1A1410)',
    color: 'var(--px-ink, #1A1410)',
    cursor: 'pointer',
  };

  const infoStyle: React.CSSProperties = isPixel
    ? {
        background: 'var(--px-muted, #F1E8D5)',
        border: '1.5px solid var(--px-ink, #1A1410)',
        color: 'var(--px-ink, #1A1410)',
      }
    : isDark
    ? { background: 'rgba(255,255,255,.04)', border: '1px solid rgba(255,255,255,.08)', color: 'rgba(255,255,255,.7)' }
    : { background: 'rgba(0,0,0,.03)', border: '1px solid rgba(0,0,0,.08)', color: 'rgba(0,0,0,.65)' };

  const previewBorder = isPixel
    ? '2px solid var(--px-ink, #1A1410)'
    : isDark
    ? '1px solid rgba(255,255,255,.12)'
    : '1px solid rgba(0,0,0,.10)';

  // 输出 handle 颜色按 kind 变
  const outColor = PORT_COLOR[pickKind] || COLOR;
  const targetHandleStyle: React.CSSProperties = isPixel
    ? { background: '#fda4af', border: '1.5px solid var(--px-ink, #1A1410)', borderRadius: 0, width: 10, height: 10 }
    : { background: '#fda4af', border: 0 };
  const sourceHandleStyle: React.CSSProperties = isPixel
    ? { background: outColor, border: '1.5px solid var(--px-ink, #1A1410)', borderRadius: 0, width: 10, height: 10 }
    : { background: outColor, border: 0 };

  // kind 切按钮 (v1.2.8.8: pixel 模式不再用 px-btn 类, 避免 pill 9999px 圆角与 padding 14px 被挤压变圆球)
  const kindBtnClass = (k: MaterialKind, active: boolean) =>
    isPixel
      ? `flex-1 flex items-center justify-center gap-1 py-1 px-1 text-[10px] font-semibold whitespace-nowrap`
      : active
      ? isDark
        ? 'flex-1 flex items-center justify-center gap-1 py-1 rounded text-[10px] font-medium bg-orange-500/30 text-orange-200 border border-orange-400/40'
        : 'flex-1 flex items-center justify-center gap-1 py-1 rounded text-[10px] font-medium bg-orange-100 text-orange-700 border border-orange-300'
      : isDark
      ? 'flex-1 flex items-center justify-center gap-1 py-1 rounded text-[10px] font-medium bg-white/5 hover:bg-white/10 text-white/60 border border-white/10'
      : 'flex-1 flex items-center justify-center gap-1 py-1 rounded text-[10px] font-medium bg-black/5 hover:bg-black/10 text-black/60 border border-black/10';

  // v1.2.8.8: pixel kind 按钮的 inline 样式 (方角 + min-width:0 允许压缩 + cursor)
  const pixelKindBtnStyle = (active: boolean): React.CSSProperties => ({
    background: active ? 'var(--px-peach, #FFCBA4)' : 'var(--px-surface, #FFFFFF)',
    border: '1.5px solid var(--px-ink, #1A1410)',
    borderRadius: 0,
    boxShadow: active ? '2px 2px 0 var(--px-ink, #1A1410)' : '1px 1px 0 var(--px-ink, #1A1410)',
    color: 'var(--px-ink, #1A1410)',
    minWidth: 0,
    cursor: 'pointer',
  });

  const inputStyle: React.CSSProperties = isPixel
    ? {
        background: 'var(--px-surface, #FFFFFF)',
        border: '1.5px solid var(--px-ink, #1A1410)',
        color: 'var(--px-ink, #1A1410)',
        borderRadius: 0,
      }
    : isDark
    ? { background: 'rgba(255,255,255,.06)', border: '1px solid rgba(255,255,255,.12)', color: '#fff', borderRadius: 4 }
    : { background: 'rgba(0,0,0,.03)', border: '1px solid rgba(0,0,0,.10)', color: '#111', borderRadius: 4 };

  const Icon = KIND_ICONS[pickKind];

  // ===== 渲染 =====
  return (
    <div className="relative" style={containerStyle}>
      {/* 输入: any 4 类聚合 (这里给 rose 兜底, 实际 portTypes.ts 申明 4 类) */}
      <Handle type="target" position={Position.Left} style={targetHandleStyle} />
      {/* 输出: 单 source (颜色随 kind 变化) */}
      <Handle type="source" position={Position.Right} style={sourceHandleStyle} />

      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2" style={{ borderBottom: headerBorder }}>
        <div className="w-6 h-6 flex items-center justify-center" style={{ ...iconBoxStyle, borderRadius: isPixel ? 0 : 6 }}>
          <Filter size={13} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold truncate" style={{ color: titleColor }}>
            从合集获取
          </div>
          <div className="text-[10px]" style={{ color: subColor }}>
            {total > 0 ? `共 ${total} 个 · 取第 ${safeIndex} 个` : '上游暂无素材'}
          </div>
        </div>
      </div>

      {/* Body */}
      <div className="p-2.5 space-y-2" onMouseDown={(e) => e.stopPropagation()}>
        {/* kind 切换 */}
        <div className="flex items-center gap-1.5">
          {(['text', 'image', 'video', 'audio'] as MaterialKind[]).map((k) => {
            const KIcon = KIND_ICONS[k];
            return (
              <button
                key={k}
                type="button"
                className={kindBtnClass(k, k === pickKind)}
                style={isPixel ? pixelKindBtnStyle(k === pickKind) : undefined}
                onClick={() => update({ pickKind: k, status: 'idle', error: null })}
                title={KIND_LABEL[k]}
              >
                <KIcon size={10} />
                <span>{KIND_LABEL[k]}</span>
              </button>
            );
          })}
        </div>

        {/* index 输入 */}
        <div className="flex items-center gap-1.5">
          <div
            className="flex items-center gap-1 px-2 py-1 text-[10px] flex-shrink-0"
            style={{ ...infoStyle, borderRadius: isPixel ? 0 : 6 }}
          >
            <ListOrdered size={11} />
            <span>序号</span>
          </div>
          <input
            type="number"
            min={1}
            max={Math.max(total, 1)}
            value={pickIndex}
            onChange={(e) => {
              const v = parseInt(e.target.value, 10);
              if (!isNaN(v) && v >= 1) update({ pickIndex: v });
            }}
            className="flex-1 px-2 py-1 text-xs text-center"
            style={inputStyle}
          />
          <div
            className="px-2 py-1 text-[10px] flex-shrink-0"
            style={{ ...infoStyle, borderRadius: isPixel ? 0 : 6 }}
            title={`总计 ${total}`}
          >
            / {total}
          </div>
        </div>

        {/* 主按钮 */}
        <button
          onClick={() => requestCanvasNodeRun(p.id)}
          disabled={status === 'running' || total === 0}
          className={btnClass}
          style={isPixel ? { ...pixelBtnStyle, opacity: status === 'running' || total === 0 ? 0.55 : 1 } : undefined}
        >
          {status === 'running' ? (
            <>
              <Loader2 size={11} className="animate-spin" /> 取出中…
            </>
          ) : (
            <>
              <Play size={11} /> 取出第 {safeIndex} 个
            </>
          )}
        </button>

        {/* 错误条 */}
        {error && (
          <div
            className="flex items-start gap-1 text-[10px] px-2 py-1"
            style={{
              background: isPixel ? 'var(--px-pink, #FFB5C5)' : 'rgba(239,68,68,.10)',
              border: isPixel ? '1.5px solid var(--px-ink, #1A1410)' : '1px solid rgba(239,68,68,.25)',
              color: isPixel ? 'var(--px-ink, #1A1410)' : isDark ? 'rgb(252,165,165)' : 'rgb(185,28,28)',
              borderRadius: isPixel ? 0 : 6,
            }}
          >
            <AlertCircle size={11} className="mt-0.5 flex-shrink-0" />
            <span className="break-all">{error}</span>
          </div>
        )}

        {/* 当前素材预览 (v1.2.8.8: 拓宽高度 并让图按宽度铺满, 避免人像图只占中间 1/3 宽两侧大量留白) */}
        {currentValue && (
          <div
            className="overflow-hidden flex items-center justify-center w-full"
            style={{
              border: previewBorder,
              borderRadius: isPixel ? 0 : 6,
              background: isPixel
                ? 'var(--px-muted, #F1E8D5)'
                : isDark
                ? 'rgba(255,255,255,.04)'
                : 'rgba(0,0,0,.04)',
              boxShadow: isPixel ? '2px 2px 0 var(--px-ink, #1A1410)' : 'none',
              minHeight: pickKind === 'text' ? 36 : 100,
              maxHeight: 260,
            }}
          >
            {pickKind === 'image' && (
              <SmartImage src={currentValue} alt="picked" style={{ width: '100%', maxHeight: 260, objectFit: 'contain', display: 'block' }} draggable={false} thumbSize={720} />
            )}
            {pickKind === 'video' && (
              <LoopingVideo src={currentValue} style={{ width: '100%', maxHeight: 260, objectFit: 'contain', display: 'block' }} muted />
            )}
            {pickKind === 'audio' && (
              <audio src={currentValue} controls className="w-full" />
            )}
            {pickKind === 'text' && (
              <div
                className="text-[11px] leading-snug px-2 py-1.5 w-full break-words"
                style={{ color: isPixel ? 'var(--px-ink, #1A1410)' : isDark ? '#e2e8f0' : '#111' }}
              >
                {currentValue.length > 200 ? currentValue.slice(0, 200) + '…' : currentValue}
              </div>
            )}
          </div>
        )}

        {/* footer：当前 kind 输出标识 */}
        <div
          className="flex items-center justify-end gap-1 text-[9px]"
          style={{ color: subColor }}
        >
          <Icon size={10} />
          <span>输出: {KIND_LABEL[pickKind]}</span>
        </div>
      </div>
    </div>
  );
};

export default memo(PickFromSetNode);
