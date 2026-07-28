import { memo, useState, useRef, useCallback, useMemo } from 'react';
import { Handle, Position, useReactFlow, type NodeProps } from '@xyflow/react';
import { Scissors, Loader2, AlertCircle, Sparkles } from 'lucide-react';
import { useUpdateNodeData } from './useUpdateNodeData';
import { useRunTrigger } from '../../hooks/useRunTrigger';
import { requestCanvasNodeRun } from '../../utils/canvasRunRequest';
import SmartImage from '../SmartImage';

/**
 * FrameExtractorNode - 视频抽帧
 * 接受上游 imageUrl(实际是视频 URL),按指定间隔/数量抽帧,
 * 通过 HTML5 video + canvas 在前端截图,
 * 然后批量上传到后端 /api/files/upload-base64,得到本地 url 数组写入 data.urls
 *
 * 不依赖 ffmpeg,纯浏览器实现
 */
const COLOR = '#fb923c';

const FrameExtractorNode = (p: NodeProps) => {
  const update = useUpdateNodeData(p.id);
  const { getEdges, getNodes } = useReactFlow();
  const d = p.data as any;
  const count: number = d?.count || 4;
  const status: 'idle' | 'running' | 'success' | 'error' = d?.status || 'idle';
  const urls: string[] = d?.urls || [];
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  const upstreamVideo = useMemo(() => {
    const edges = getEdges();
    const nodes = getNodes();
    const upstreamIds = edges.filter((e) => e.target === p.id).map((e) => e.source);
    for (const uid of upstreamIds) {
      const n = nodes.find((x) => x.id === uid);
      const data = (n?.data as any) || {};
      const direct = [
        data.videoUrl,
        ...(Array.isArray(data.videoUrls) ? data.videoUrls : []),
        ...(Array.isArray(data.generatedVideos) ? data.generatedVideos : []),
        ...(Array.isArray(data.videos) ? data.videos : []),
      ];
      for (const value of direct) {
        const url = typeof value === 'string'
          ? value
          : typeof value?.url === 'string'
            ? value.url
            : typeof value?.videoUrl === 'string'
              ? value.videoUrl
              : '';
        if (url) return url;
      }
      const legacy = data.imageUrl;
      if (legacy && /\.(mp4|webm|mov|m4v|mkv)(\?|$)/i.test(legacy)) return legacy as string;
    }
    return '';
  }, [getEdges, getNodes, p.id, p.data]);

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
        reject(new Error('视频跳转失败'));
      };
      vid.addEventListener('seeked', onSeek);
      vid.addEventListener('error', onErr);
      vid.currentTime = t;
    });

  const handleExtract = useCallback(async () => {
    setError(null);
    if (!upstreamVideo) {
      setError('请连接上游视频节点');
      return;
    }
    update({ status: 'running', urls: [] });
    setProgress({ done: 0, total: count });

    try {
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
          reject(new Error('视频加载失败(可能 CORS)'));
        };
        vid.addEventListener('loadedmetadata', onMeta);
        vid.addEventListener('error', onErr);
        vid.load();
      });

      const duration = vid.duration || 0;
      if (!duration) throw new Error('无法读取视频时长');

      const canvas = document.createElement('canvas');
      canvas.width = vid.videoWidth || 1280;
      canvas.height = vid.videoHeight || 720;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('canvas 不可用');

      const out: string[] = [];
      for (let i = 0; i < count; i++) {
        const t = (duration / (count + 1)) * (i + 1);
        await seekTo(vid, t);
        ctx.drawImage(vid, 0, 0, canvas.width, canvas.height);
        const dataUrl = canvas.toDataURL('image/png');
        const r = await fetch('/api/files/upload-base64', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dataUrl, prefix: 'frame' }),
        });
        const json = await r.json();
        if (!r.ok || !json.success) throw new Error(json?.error || `HTTP ${r.status}`);
        out.push(json.data.url);
        setProgress({ done: i + 1, total: count });
        update({ urls: [...out] });
      }

      update({ status: 'success', urls: out, imageUrl: out[0] });
    } catch (e: any) {
      setError(e?.message || '抽帧失败');
      update({ status: 'error' });
    } finally {
      setProgress(null);
    }
  }, [upstreamVideo, count, update]);

  // 接入运行总线,供批量运行调起
  useRunTrigger(p.id, async () => {
    if (status === 'running') return;
    await handleExtract();
  });

  return (
    <div
      className={`relative rounded-xl border-2 transition-all ${
        p.selected ? 'shadow-2xl' : 'border-white/15 hover:border-white/30'
      }`}
      style={{
        background: 'rgba(20,20,22,.92)',
        backdropFilter: 'blur(8px)',
        width: 280,
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
          <Scissors size={13} />
        </div>
        <div className="flex-1">
          <div className="text-sm font-semibold text-white">视频抽帧</div>
          <div className="text-[10px] text-white/40">
            {upstreamVideo ? `已连接视频` : '未连接视频'}
          </div>
        </div>
      </div>

      <div className="p-2.5 space-y-2" onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2">
          <label className="text-[10px] text-white/50">帧数</label>
          <input
            type="number"
            min={1}
            max={20}
            value={count}
            onChange={(e) => update({ count: Math.max(1, parseInt(e.target.value) || 4) })}
            className="w-16 bg-white/5 border border-white/10 rounded px-2 py-0.5 text-[11px] text-white outline-none focus:border-white/30"
          />
          <span className="text-[10px] text-white/40">均匀抽取</span>
        </div>

        <button
          onClick={() => requestCanvasNodeRun(p.id)}
          disabled={status === 'running' || !upstreamVideo}
          className="w-full flex items-center justify-center gap-1.5 py-1.5 rounded text-xs font-medium disabled:opacity-50 transition-colors bg-orange-500/20 hover:bg-orange-500/30 text-orange-200"
        >
          {status === 'running' ? (
            <>
              <Loader2 size={11} className="animate-spin" />
              {progress ? ` 抽帧 ${progress.done}/${progress.total}` : ' 处理中...'}
            </>
          ) : (
            <>
              <Sparkles size={11} /> 开始抽帧
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

      {urls.length > 0 && (
        <div className="border-t border-white/10 p-2 grid grid-cols-2 gap-1">
          {urls.map((u, i) => (
            <SmartImage key={i} src={u} alt={`帧 ${i}`} className="w-full rounded object-cover" thumbSize={240} />
          ))}
        </div>
      )}
    </div>
  );
};

export default memo(FrameExtractorNode);
