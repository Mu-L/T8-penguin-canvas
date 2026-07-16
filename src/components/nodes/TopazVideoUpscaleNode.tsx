import { memo, useEffect, useMemo, useState } from 'react';
import { Handle, Position, useEdges, useNodes } from '@xyflow/react';
import {
  AlertTriangle,
  CheckCircle2,
  Film,
  Gauge,
  Info,
  Loader2,
  RefreshCw,
  SlidersHorizontal,
  Sparkles,
  Video,
} from 'lucide-react';
import { getTopazStatus, runTopazVideo, type TopazStatus } from '../../services/topaz';
import { fileNameFromUrl, getMediaItemsFromData, type MediaItem } from '../../utils/mediaCollection';
import { useRunTrigger } from '../../hooks/useRunTrigger';
import { requestCanvasNodeRun } from '../../utils/canvasRunRequest';
import { useUpdateNodeData } from './useUpdateNodeData';
import { useHasAutoOutput } from './useHasAutoOutput';
import LoopingVideo from '../LoopingVideo';

const UPSCALE_MODELS = [
  'iris-3',
  'iris-2',
  'thf-4',
  'thd-3',
  'thm-2',
  'rhea-1',
  'rxl-1',
  'nyx-3',
  'prob-4',
  'ghq-5',
  'aaa-9',
  'ahq-12',
  'alq-13',
  'alqs-2',
  'amq-13',
  'amqs-2',
];
const INTERPOLATION_MODELS = ['apo-8', 'apf-1', 'chr-2', 'chf-3'];
const DEFAULT_TOPAZ_VIDEO_DIR = 'C:\\Program Files\\Topaz Labs LLC\\Topaz Video AI';

function FieldLabel({ children }: { children: React.ReactNode }) {
  return <label className="text-[10px] font-semibold" style={{ color: 'var(--t8-text-muted)' }}>{children}</label>;
}

function SmallHint({ children }: { children: React.ReactNode }) {
  return <div className="text-[10px] leading-snug" style={{ color: 'var(--t8-text-dim)' }}>{children}</div>;
}

function NumberInput({
  value,
  min,
  max,
  step,
  onChange,
}: {
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onChange: (value: number) => void;
}) {
  return (
    <input
      className="t8-input nodrag nowheel w-full px-2 py-1 text-xs"
      type="number"
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={(event) => onChange(Number(event.target.value) || 0)}
    />
  );
}

function ToggleRow({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-[11px] cursor-pointer" style={{ color: 'var(--t8-text-main)' }}>
      <input className="nodrag" type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      {label}
    </label>
  );
}

function collectUpstreamVideos(id: string, edges: any[], nodes: any[]): MediaItem[] {
  const upstreamIds = edges.filter((edge) => edge.target === id).map((edge) => edge.source);
  const seen = new Set<string>();
  const out: MediaItem[] = [];
  for (const sourceId of upstreamIds) {
    const node = nodes.find((item) => item.id === sourceId);
    for (const item of getMediaItemsFromData(node?.data || {}, 'video')) {
      if (!item.url || seen.has(item.url)) continue;
      seen.add(item.url);
      out.push(item);
    }
  }
  return out;
}

function statusLabel(status: TopazStatus | null, loading: boolean) {
  if (loading) return '检测中';
  if (!status) return '待检测';
  return status.video.installed ? '已检测' : '未检测到';
}

function TopazVideoUpscaleNode({ id, data, selected }: { id: string; data: any; selected?: boolean }) {
  const update = useUpdateNodeData(id);
  const edges = useEdges();
  const nodes = useNodes();
  const hasAutoOutput = useHasAutoOutput(id);
  const [status, setStatus] = useState<TopazStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);
  const [localError, setLocalError] = useState('');

  const d = data || {};
  const topazVideoPath = typeof d.topazVideoPath === 'string' ? d.topazVideoPath : '';
  const enableUpscale = d.topazVideoEnableUpscale !== false;
  const upscaleModel = typeof d.topazVideoUpscaleModel === 'string' ? d.topazVideoUpscaleModel : 'iris-3';
  const rawUpscaleFactor = Number(d.topazVideoUpscaleFactor ?? 2);
  const upscaleFactor = upscaleModel === 'thm-2' ? 1 : rawUpscaleFactor;
  const compression = Number(d.topazVideoCompression ?? 1);
  const blend = Number(d.topazVideoBlend ?? 0);
  const enableInterpolation = d.topazVideoEnableInterpolation === true;
  const inputFps = Number(d.topazVideoInputFps ?? 24);
  const interpolationMultiplier = Number(d.topazVideoInterpolationMultiplier ?? 2);
  const interpolationModel = typeof d.topazVideoInterpolationModel === 'string' ? d.topazVideoInterpolationModel : 'apo-8';
  const useGpu = d.topazVideoUseGpu !== false;
  const preserveAudio = d.topazVideoPreserveAudio !== false;
  const showAdvanced = d.topazVideoShowAdvanced === true;
  const statusText = d.status || 'idle';
  const outputUrls: string[] = Array.isArray(d.videoUrls) && d.videoUrls.length > 0
    ? d.videoUrls
    : d.videoUrl
      ? [d.videoUrl]
      : [];

  const upstreamVideos = useMemo(
    () => collectUpstreamVideos(id, edges, nodes),
    [id, edges, nodes, data],
  );
  const inputVideo = upstreamVideos[0]?.url || '';

  const refreshStatus = async () => {
    setStatusLoading(true);
    try {
      setStatus(await getTopazStatus({ topazVideoPath: topazVideoPath || undefined }));
    } catch (error: any) {
      setStatus({
        gigapixel: { installed: false, setupHints: [] },
        video: {
          installed: false,
          defaultTopazVideoDir: DEFAULT_TOPAZ_VIDEO_DIR,
          setupHints: [error?.message || 'Topaz Video AI 状态检查失败'],
        },
        models: { gigapixel: [], gigapixelCodes: [], videoUpscale: [], videoInterpolation: [] },
      });
    } finally {
      setStatusLoading(false);
    }
  };

  useEffect(() => {
    refreshStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleRun = async () => {
    setLocalError('');
    if (!inputVideo) {
      const msg = '请连接上游视频素材';
      setLocalError(msg);
      update({ status: 'error', error: msg });
      return;
    }
    if (!enableUpscale && !enableInterpolation) {
      const msg = '请至少开启「放大」或「补帧」其中一个处理动作';
      setLocalError(msg);
      update({ status: 'error', error: msg });
      return;
    }
    update({ status: 'running', error: '', videoUrl: '', videoUrls: [] });
    try {
      const result = await runTopazVideo({
        videoUrl: inputVideo,
        topazVideoPath: topazVideoPath || undefined,
        enableUpscale,
        upscaleFactor,
        upscaleModel,
        compression,
        blend,
        enableInterpolation,
        inputFps,
        interpolationMultiplier,
        interpolationModel,
        useGpu,
        preserveAudio,
      });
      const urls = result.outputUrls?.length ? result.outputUrls : [result.outputUrl];
      update({
        status: 'success',
        error: '',
        videoUrl: urls[0],
        videoUrls: urls,
        fileName: result.fileName || fileNameFromUrl(urls[0]),
        fileSize: result.size || 0,
        mime: result.mime || 'video/mp4',
        topazVideoResult: result,
        metadata: { ...(d.metadata || {}), topazVideoResult: result },
      });
    } catch (error: any) {
      const msg = error?.message || 'Topaz 视频高清化失败';
      setLocalError(msg);
      update({ status: 'error', error: msg });
    }
  };

  useRunTrigger(id, handleRun, 'topaz-video-upscale');

  const error = localError || d.error || '';
  const installed = status?.video.installed === true;
  const modelEnvReady = status?.video.modelEnvReady === true;
  const targetFps = Math.max(1, Math.round(inputFps * interpolationMultiplier));

  return (
    <div
      className={`t8-node overflow-hidden ${selected ? 'ring-2' : ''}`}
      style={{
        width: 420,
        borderColor: selected ? 'var(--t8-accent)' : 'var(--t8-border-strong)',
        boxShadow: selected ? '0 0 0 2px color-mix(in srgb, var(--t8-accent) 32%, transparent)' : undefined,
      }}
    >
      <Handle type="target" position={Position.Left} style={{ background: '#fb7185', border: '1px solid var(--t8-bg-node)' }} />
      <Handle type="source" position={Position.Right} style={{ background: '#fb7185', border: '1px solid var(--t8-bg-node)' }} />

      <div className="t8-node-header flex items-center gap-2 px-3 py-2">
        <div className="flex h-8 w-8 items-center justify-center rounded-md" style={{ background: '#fb7185', color: '#2a0610' }}>
          <Video size={17} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-bold">Topaz视频高清化</div>
          <div className="truncate text-[10px]" style={{ color: 'var(--t8-text-muted)' }}>
            {enableUpscale ? `${upscaleModel} · ${upscaleFactor}x` : '不放大'} · {enableInterpolation ? `补帧 ${targetFps}fps` : '不补帧'}
          </div>
        </div>
        <div className="flex items-center gap-1 text-[10px] font-bold" style={{ color: installed ? '#16a34a' : 'var(--t8-text-dim)' }}>
          {installed ? <CheckCircle2 size={12} /> : <AlertTriangle size={12} />}
          {statusLabel(status, statusLoading)}
        </div>
      </div>

      <div className="nodrag nowheel space-y-2 p-3" onMouseDown={(event) => event.stopPropagation()}>
        <div className="t8-card flex items-start gap-2 px-2 py-2">
          <Info size={14} style={{ color: '#fb7185' }} />
          <div className="min-w-0 flex-1">
            <div className="text-[11px] font-semibold">需要本机已安装并登录 Topaz Video AI。</div>
            <SmallHint>必须使用 Topaz Video AI 自带 ffmpeg.exe；未登录或模型目录未配置时会出现 tvai_up / tvai_fi 过滤器错误。</SmallHint>
          </div>
        </div>

        {inputVideo ? (
          <div className="space-y-1 rounded-md border p-2" style={{ borderColor: 'var(--t8-border)' }}>
            <LoopingVideo src={inputVideo} controls className="max-h-36 w-full rounded bg-black object-contain" />
            <div className="truncate text-[11px] font-semibold" style={{ color: 'var(--t8-text-main)' }}>{upstreamVideos[0]?.name || fileNameFromUrl(inputVideo)}</div>
            <SmallHint>{upstreamVideos.length > 1 ? `检测到 ${upstreamVideos.length} 个视频，当前处理第 1 个。` : '连接上游上传素材、资源库视频或视频输出。'}</SmallHint>
          </div>
        ) : (
          <div className="rounded-md border border-dashed px-3 py-4 text-center text-[11px]" style={{ borderColor: 'var(--t8-border)', color: 'var(--t8-text-dim)' }}>
            连接一个视频后运行高清化 / 补帧
          </div>
        )}

        <div className="grid grid-cols-2 gap-2 rounded-md border p-2" style={{ borderColor: 'var(--t8-border)' }}>
          <ToggleRow label="放大" checked={enableUpscale} onChange={(value) => update({ topazVideoEnableUpscale: value })} />
          <ToggleRow label="补帧" checked={enableInterpolation} onChange={(value) => update({ topazVideoEnableInterpolation: value })} />
          <div>
            <FieldLabel>放大模型</FieldLabel>
            <select className="t8-select w-full px-2 py-1.5 text-xs" value={upscaleModel} disabled={!enableUpscale} onChange={(event) => update({ topazVideoUpscaleModel: event.target.value })}>
              {UPSCALE_MODELS.map((item) => <option key={item} value={item}>{item}</option>)}
            </select>
          </div>
          <div>
            <FieldLabel>倍数</FieldLabel>
            <select
              className="t8-select w-full px-2 py-1.5 text-xs"
              value={upscaleFactor}
              disabled={!enableUpscale || upscaleModel === 'thm-2'}
              onChange={(event) => update({ topazVideoUpscaleFactor: Number(event.target.value) })}
            >
              {[1, 1.5, 2, 3, 4].map((item) => <option key={item} value={item}>{item}x</option>)}
            </select>
            {upscaleModel === 'thm-2' && <SmallHint>thm-2 固定 1x。</SmallHint>}
          </div>
          <div>
            <FieldLabel>补帧模型</FieldLabel>
            <select className="t8-select w-full px-2 py-1.5 text-xs" value={interpolationModel} disabled={!enableInterpolation} onChange={(event) => update({ topazVideoInterpolationModel: event.target.value })}>
              {INTERPOLATION_MODELS.map((item) => <option key={item} value={item}>{item}</option>)}
            </select>
          </div>
          <div>
            <FieldLabel>目标 FPS</FieldLabel>
            <div className="grid grid-cols-2 gap-1">
              <input className="t8-input w-full px-2 py-1.5 text-xs" type="number" min={1} max={240} value={inputFps} disabled={!enableInterpolation} onChange={(event) => update({ topazVideoInputFps: Number(event.target.value) || 24 })} />
              <select className="t8-select w-full px-1 py-1.5 text-xs" value={interpolationMultiplier} disabled={!enableInterpolation} onChange={(event) => update({ topazVideoInterpolationMultiplier: Number(event.target.value) })}>
                {[1.5, 2, 3, 4].map((item) => <option key={item} value={item}>{item}x</option>)}
              </select>
            </div>
            <SmallHint>{enableInterpolation ? `${inputFps} × ${interpolationMultiplier} = ${targetFps}fps` : '开启补帧后生效。'}</SmallHint>
          </div>
        </div>

        <div className="space-y-1">
          <FieldLabel>Topaz Video AI 安装目录（可选）</FieldLabel>
          <input
            className="t8-input nodrag w-full px-2 py-1.5 text-[11px]"
            value={topazVideoPath}
            placeholder={status?.video.defaultTopazVideoDir || DEFAULT_TOPAZ_VIDEO_DIR}
            onChange={(event) => update({ topazVideoPath: event.target.value })}
          />
          <SmallHint>{status?.video.source ? `检测来源：${status.video.source}` : '可填安装目录，也可直接填 ffmpeg.exe 路径。'}</SmallHint>
        </div>

        <div className="grid grid-cols-[1fr_auto] gap-2">
          <button type="button" className="t8-btn px-2 py-1.5 text-xs" onClick={refreshStatus} disabled={statusLoading}>
            {statusLoading ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
            检测本机
          </button>
          <button type="button" className="t8-btn px-2 py-1.5 text-xs" onClick={() => update({ topazVideoShowAdvanced: !showAdvanced })}>
            <SlidersHorizontal size={13} />
            高级
          </button>
        </div>

        {status && !modelEnvReady && (
          <div className="flex items-start gap-1 rounded-md border px-2 py-1.5 text-[10px]" style={{ borderColor: 'var(--t8-border)', color: 'var(--t8-text-muted)' }}>
            <Gauge size={12} />
            <span>未检测到完整 TVAI 模型目录环境变量。登录 Topaz Video AI 后按 Ctrl+Shift+T，或在安装目录运行 .\login。</span>
          </div>
        )}

        {showAdvanced && (
          <div className="grid grid-cols-2 gap-2 rounded-md border p-2" style={{ borderColor: 'var(--t8-border)' }}>
            <ToggleRow label="GPU 编码" checked={useGpu} onChange={(value) => update({ topazVideoUseGpu: value })} />
            <ToggleRow label="保留音轨" checked={preserveAudio} onChange={(value) => update({ topazVideoPreserveAudio: value })} />
            <div>
              <FieldLabel>Compression</FieldLabel>
              <NumberInput value={compression} min={-1} max={1} step={0.1} onChange={(value) => update({ topazVideoCompression: value })} />
            </div>
            <div>
              <FieldLabel>Blend</FieldLabel>
              <NumberInput value={blend} min={0} max={1} step={0.1} onChange={(value) => update({ topazVideoBlend: value })} />
            </div>
            <div className="col-span-2">
              <SmallHint>放大和补帧会合并为同一次 Topaz ffmpeg filter chain：tvai_up,tvai_fi，避免中间文件复制导致逻辑走错。</SmallHint>
            </div>
          </div>
        )}

        <button type="button" className="t8-btn t8-btn-primary w-full px-3 py-2 text-sm" onClick={() => requestCanvasNodeRun(id)} disabled={statusText === 'running'}>
          {statusText === 'running' ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
          {statusText === 'running' ? '处理中...' : '运行视频高清化'}
        </button>

        {error && (
          <div className="rounded-md border px-2 py-1.5 text-[11px] whitespace-pre-wrap" style={{ borderColor: '#ef444466', color: '#ef4444' }}>
            {error}
          </div>
        )}

        {!hasAutoOutput && outputUrls.length > 0 && (
          <div className="space-y-1">
            <LoopingVideo src={outputUrls[0]} controls className="max-h-44 w-full rounded bg-black object-contain" />
            <div className="flex items-center gap-1 text-[10px]" style={{ color: 'var(--t8-text-muted)' }}>
              <Film size={11} /> 输出视频 · {fileNameFromUrl(outputUrls[0])}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default memo(TopazVideoUpscaleNode);
