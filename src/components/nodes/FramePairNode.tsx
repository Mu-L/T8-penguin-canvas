import { memo, useCallback, useRef, useState } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import {
  AlertCircle,
  ChevronFirst,
  ChevronLast,
  Film,
  Loader2,
  Sparkles,
} from 'lucide-react';
import { useUpdateNodeData } from './useUpdateNodeData';
import { useRunTrigger } from '../../hooks/useRunTrigger';
import { requestCanvasNodeRun } from '../../utils/canvasRunRequest';
import { useThemeStore } from '../../stores/theme';
import { useUpstreamMaterials } from './useUpstreamMaterials';
import SmartImage from '../SmartImage';

/**
 * FramePairNode - 「首尾帧获取」工具节点
 *
 * 设计:
 *   1. 输入(左侧 target): video —— 接收上游 video 节点 / upload(video) / output(video) 输出
 *   2. 输出(右侧 source × 2): image
 *      - id="first": 首帧 (top: 36%) + 标签「首」
 *      - id="last":  尾帧 (top: 64%) + 标签「尾」
 *      下游聚合机制 (useUpstreamMaterials) 与 AudioNode 双轨对齐:
 *      节点同时把首/尾帧写入 imageUrl(=首) + imageUrls=[首,尾],
 *      下游 OutputNode / ImageNode 会自动收到两张，并按 sourceHandle 视觉区分。
 *
 *   3. 运行: 浏览器端 video + canvas 抽 t≈0 / t≈duration-0.05 两帧 →
 *      base64 → POST /api/files/upload-base64 → data.firstFrameUrl / lastFrameUrl
 *
 *   4. 双主题: pixel(糖果硬阴影) / dark(深色玻璃) / light(浅色玻璃)
 *
 *   5. 接入运行总线: useRunTrigger(id, handleExtract) → 批量运行可触发
 */

const COLOR = '#fb923c'; // utility 系一致的 orange-400

const seekTo = (vid: HTMLVideoElement, t: number) =>
  new Promise<void>((resolve, reject) => {
    const onSeek = () => {
      vid.removeEventListener('seeked', onSeek);
      vid.removeEventListener('error', onErr);
      resolve();
    };
    const onErr = () => {
      vid.removeEventListener('seeked', onSeek);
      vid.removeEventListener('error', onErr);
      reject(new Error('视频跳转失败(可能 CORS)'));
    };
    vid.addEventListener('seeked', onSeek);
    vid.addEventListener('error', onErr);
    // 钳制时间在合法区间, 避免 currentTime 越界 NaN
    vid.currentTime = Math.max(0, Math.min(t, (vid.duration || 0) - 0.001));
  });

const FramePairNode = (p: NodeProps) => {
  const update = useUpdateNodeData(p.id);
  const d = (p.data as any) || {};
  const { theme, style } = useThemeStore();
  const isPixel = style === 'pixel';
  const isDark = theme === 'dark';

  const status: 'idle' | 'running' | 'success' | 'error' = d?.status || 'idle';
  const firstUrl: string = d?.firstFrameUrl || '';
  const lastUrl: string = d?.lastFrameUrl || '';
  const [error, setError] = useState<string | null>(d?.error || null);
  const [phase, setPhase] = useState<'load' | 'first' | 'last' | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  // 上游视频 URL: useUpstreamMaterials 已订阅上游 data 变化, 自动重渲染
  const { videos } = useUpstreamMaterials(p.id);
  const upstreamVideo = videos[0]?.url || '';

  // ===== 抽帧主流程 =====
  const handleExtract = useCallback(async () => {
    setError(null);
    if (!upstreamVideo) {
      setError('请连接上游视频节点');
      return;
    }
    update({
      status: 'running',
      error: null,
      firstFrameUrl: '',
      lastFrameUrl: '',
      // v1.2.8.4: 显式清掉历史残留的 imageUrl/imageUrls (旧画布可能有 v1.2.8.2 之前写入的值)
      imageUrl: '',
      imageUrls: [],
    });

    try {
      setPhase('load');
      const vid = videoRef.current || document.createElement('video');
      videoRef.current = vid;
      vid.crossOrigin = 'anonymous';
      vid.src = upstreamVideo;
      vid.muted = true;
      vid.playsInline = true;

      await new Promise<void>((resolve, reject) => {
        const onMeta = () => {
          vid.removeEventListener('loadedmetadata', onMeta);
          vid.removeEventListener('error', onErr);
          resolve();
        };
        const onErr = () => {
          vid.removeEventListener('loadedmetadata', onMeta);
          vid.removeEventListener('error', onErr);
          reject(new Error('视频加载失败(可能 CORS / 格式不支持)'));
        };
        vid.addEventListener('loadedmetadata', onMeta);
        vid.addEventListener('error', onErr);
        vid.load();
      });

      const duration = vid.duration || 0;
      if (!duration || !isFinite(duration)) throw new Error('无法读取视频时长');

      const w = vid.videoWidth || 1280;
      const h = vid.videoHeight || 720;
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('canvas 不可用');

      const upload = async (dataUrl: string, prefix: string) => {
        const r = await fetch('/api/files/upload-base64', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dataUrl, prefix }),
        });
        const json = await r.json();
        if (!r.ok || !json?.success) {
          throw new Error(json?.error || `上传失败 HTTP ${r.status}`);
        }
        return json.data.url as string;
      };

      // ---- 首帧 (t≈0.001 避开纯黑预覽) ----
      setPhase('first');
      await seekTo(vid, 0.001);
      ctx.drawImage(vid, 0, 0, w, h);
      const firstDataUrl = canvas.toDataURL('image/png');
      const firstOut = await upload(firstDataUrl, 'frame-pair-first');
      // v1.2.8.3: 不再写 imageUrl, 严格依赖 firstFrameUrl + sourceHandle='first' 语义
      update({ firstFrameUrl: firstOut });

      // ---- 尾帧 (t≈duration - 0.05 避开末帧黑屏) ----
      setPhase('last');
      const tEnd = Math.max(0, duration - 0.05);
      await seekTo(vid, tEnd);
      ctx.drawImage(vid, 0, 0, w, h);
      const lastDataUrl = canvas.toDataURL('image/png');
      const lastOut = await upload(lastDataUrl, 'frame-pair-last');

      update({
        status: 'success',
        firstFrameUrl: firstOut,
        lastFrameUrl: lastOut,
        // v1.2.8.4: 双端口语义依赖 sourceHandle 过滤, 并清掉可能的历史残留
        imageUrl: '',
        imageUrls: [],
        error: null,
      });
    } catch (e: any) {
      const msg = e?.message || '抽帧失败';
      setError(msg);
      update({ status: 'error', error: msg });
    } finally {
      setPhase(null);
    }
  }, [upstreamVideo, update]);

  // 接入运行总线: 批量运行触发
  useRunTrigger(p.id, async () => {
    if (status === 'running') return;
    await handleExtract();
  });

  // ===== 双主题 token =====
  const accent = isPixel ? '#C73B6B' : COLOR;
  const containerStyle: React.CSSProperties = isPixel
    ? {
        width: 280,
        background: 'var(--px-surface, #FFFFFF)',
        border: '2px solid var(--px-ink, #1A1410)',
        borderRadius: 0,
        boxShadow: p.selected
          ? '5px 5px 0 var(--px-ink, #1A1410)'
          : '3px 3px 0 var(--px-ink, #1A1410)',
        color: 'var(--px-ink, #1A1410)',
      }
    : isDark
    ? {
        width: 280,
        background: 'rgba(20,20,22,.92)',
        backdropFilter: 'blur(8px)',
        border: '2px solid rgba(255,255,255,.15)',
        borderColor: p.selected ? COLOR : undefined,
        borderRadius: 12,
        boxShadow: p.selected
          ? `0 0 0 1px ${COLOR}, 0 16px 32px rgba(251,146,60,.2)`
          : undefined,
      }
    : {
        width: 280,
        background: 'rgba(255,255,255,.95)',
        backdropFilter: 'blur(8px)',
        border: '2px solid rgba(0,0,0,.12)',
        borderColor: p.selected ? COLOR : undefined,
        borderRadius: 12,
        boxShadow: p.selected
          ? `0 0 0 1px ${COLOR}, 0 16px 32px rgba(251,146,60,.18)`
          : '0 4px 12px rgba(0,0,0,.06)',
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
  const dividerColor = headerBorder;

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

  // 主按钮
  const btnClass = isPixel
    ? 'px-btn px-btn--peach w-full flex items-center justify-center gap-1.5 py-1.5 text-[12px]'
    : isDark
    ? 'w-full flex items-center justify-center gap-1.5 py-1.5 rounded text-xs font-medium disabled:opacity-50 transition-colors bg-orange-500/20 hover:bg-orange-500/30 text-orange-200 border border-orange-400/30'
    : 'w-full flex items-center justify-center gap-1.5 py-1.5 rounded text-xs font-medium disabled:opacity-50 transition-colors bg-orange-100 hover:bg-orange-200 text-orange-700 border border-orange-300';

  // 副信息卡(已连接 / 未连接)
  const infoStyle: React.CSSProperties = isPixel
    ? {
        background: 'var(--px-muted, #F1E8D5)',
        border: '1.5px solid var(--px-ink, #1A1410)',
        color: 'var(--px-ink, #1A1410)',
      }
    : isDark
    ? { background: 'rgba(255,255,255,.04)', border: '1px solid rgba(255,255,255,.08)', color: 'rgba(255,255,255,.7)' }
    : { background: 'rgba(0,0,0,.03)', border: '1px solid rgba(0,0,0,.08)', color: 'rgba(0,0,0,.65)' };

  const handleStyleBase = (top: string): React.CSSProperties =>
    isPixel
      ? { background: accent, border: '1.5px solid var(--px-ink, #1A1410)', borderRadius: 0, top, width: 10, height: 10 }
      : { background: COLOR, border: 0, top };

  const labelStyle: React.CSSProperties = {
    position: 'absolute',
    right: -4,
    transform: 'translateX(100%) translateY(-50%)',
    fontSize: 9,
    fontWeight: 700,
    pointerEvents: 'none',
    color: isPixel ? 'var(--px-ink, #1A1410)' : isDark ? 'rgba(254,215,170,.85)' : '#c2410c',
    background: isPixel ? 'var(--px-yellow, #FFE08A)' : 'transparent',
    padding: isPixel ? '1px 4px' : 0,
    border: isPixel ? '1.2px solid var(--px-ink, #1A1410)' : 'none',
    whiteSpace: 'nowrap',
  };

  const previewBorder = isPixel
    ? '2px solid var(--px-ink, #1A1410)'
    : isDark
    ? '1px solid rgba(255,255,255,.12)'
    : '1px solid rgba(0,0,0,.10)';

  // ===== 渲染 =====
  return (
    <div className="relative" style={containerStyle}>
      {/* 输入: video */}
      <Handle
        type="target"
        position={Position.Left}
        style={
          isPixel
            ? { background: '#fda4af', border: '1.5px solid var(--px-ink, #1A1410)', borderRadius: 0, width: 10, height: 10 }
            : { background: '#fda4af', border: 0 }
        }
      />
      {/* 输出: image × 2 (首帧 / 尾帧) */}
      <Handle type="source" id="first" position={Position.Right} style={handleStyleBase('36%')} />
      <Handle type="source" id="last" position={Position.Right} style={handleStyleBase('64%')} />
      <div style={{ ...labelStyle, top: '36%' }}>首</div>
      <div style={{ ...labelStyle, top: '64%' }}>尾</div>

      {/* Header */}
      <div
        className="flex items-center gap-2 px-3 py-2"
        style={{ borderBottom: headerBorder }}
      >
        <div
          className="w-6 h-6 flex items-center justify-center"
          style={{ ...iconBoxStyle, borderRadius: isPixel ? 0 : 6 }}
        >
          <Film size={13} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold truncate" style={{ color: titleColor }}>
            首尾帧获取
          </div>
          <div className="text-[10px]" style={{ color: subColor }}>
            {upstreamVideo ? '已连接视频 · 双输出' : '未连接视频'}
          </div>
        </div>
      </div>

      {/* Body */}
      <div
        className="p-2.5 space-y-2"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div
          className="text-[10px] px-2 py-1.5 truncate"
          style={{ ...infoStyle, borderRadius: isPixel ? 0 : 6 }}
          title={upstreamVideo || '未连接'}
        >
          {upstreamVideo
            ? `源: ${(upstreamVideo.split('/').pop() || upstreamVideo).slice(0, 36)}`
            : '请从上游 video / upload(视频) / output(视频) 节点连入'}
        </div>

        <button
          onClick={() => requestCanvasNodeRun(p.id)}
          disabled={status === 'running' || !upstreamVideo}
          className={btnClass}
          style={isPixel ? { opacity: status === 'running' || !upstreamVideo ? 0.55 : 1 } : undefined}
        >
          {status === 'running' ? (
            <>
              <Loader2 size={11} className="animate-spin" />
              {phase === 'load'
                ? '加载视频…'
                : phase === 'first'
                ? '抽取首帧…'
                : phase === 'last'
                ? '抽取尾帧…'
                : '处理中…'}
            </>
          ) : (
            <>
              <Sparkles size={11} /> 获取首尾帧
            </>
          )}
        </button>

        {error && (
          <div
            className="flex items-start gap-1 text-[10px] px-2 py-1"
            style={{
              background: isPixel
                ? 'var(--px-pink, #FFB5C5)'
                : isDark
                ? 'rgba(239,68,68,.10)'
                : 'rgba(239,68,68,.10)',
              border: isPixel
                ? '1.5px solid var(--px-ink, #1A1410)'
                : '1px solid rgba(239,68,68,.25)',
              color: isPixel
                ? 'var(--px-ink, #1A1410)'
                : isDark
                ? 'rgb(252,165,165)'
                : 'rgb(185,28,28)',
              borderRadius: isPixel ? 0 : 6,
            }}
          >
            <AlertCircle size={11} className="mt-0.5 flex-shrink-0" />
            <span className="break-all">{error}</span>
          </div>
        )}
      </div>

      {/* 双图预览 */}
      <div
        className="px-2 pb-2 grid grid-cols-2 gap-2"
        style={{ borderTop: dividerColor, paddingTop: 8 }}
      >
        {/* 首帧 */}
        <div className="flex flex-col items-center gap-1">
          <div
            className="flex items-center gap-1 text-[10px] font-semibold w-full"
            style={{ color: subColor }}
          >
            <ChevronFirst size={11} />
            <span>首帧</span>
          </div>
          <div
            className="w-full aspect-video flex items-center justify-center overflow-hidden"
            style={{
              border: previewBorder,
              borderRadius: isPixel ? 0 : 6,
              background: isPixel
                ? 'var(--px-muted, #F1E8D5)'
                : isDark
                ? 'rgba(255,255,255,.04)'
                : 'rgba(0,0,0,.04)',
              boxShadow: isPixel ? '2px 2px 0 var(--px-ink, #1A1410)' : 'none',
            }}
          >
            {firstUrl ? (
              <SmartImage
                src={firstUrl}
                alt="首帧"
                className="w-full h-full object-cover"
                draggable={false}
                thumbSize={320}
              />
            ) : (
              <span className="text-[9px]" style={{ color: subColor }}>
                {status === 'running' && phase === 'first' ? '抽帧中' : '待运行'}
              </span>
            )}
          </div>
        </div>
        {/* 尾帧 */}
        <div className="flex flex-col items-center gap-1">
          <div
            className="flex items-center gap-1 text-[10px] font-semibold w-full justify-end"
            style={{ color: subColor }}
          >
            <span>尾帧</span>
            <ChevronLast size={11} />
          </div>
          <div
            className="w-full aspect-video flex items-center justify-center overflow-hidden"
            style={{
              border: previewBorder,
              borderRadius: isPixel ? 0 : 6,
              background: isPixel
                ? 'var(--px-muted, #F1E8D5)'
                : isDark
                ? 'rgba(255,255,255,.04)'
                : 'rgba(0,0,0,.04)',
              boxShadow: isPixel ? '2px 2px 0 var(--px-ink, #1A1410)' : 'none',
            }}
          >
            {lastUrl ? (
              <SmartImage
                src={lastUrl}
                alt="尾帧"
                className="w-full h-full object-cover"
                draggable={false}
                thumbSize={320}
              />
            ) : (
              <span className="text-[9px]" style={{ color: subColor }}>
                {status === 'running' && phase === 'last' ? '抽帧中' : '待运行'}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default memo(FramePairNode);
