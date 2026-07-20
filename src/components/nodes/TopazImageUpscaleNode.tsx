import { memo, useEffect, useMemo, useState } from 'react';
import { Handle, Position, useEdges, useNodes } from '@xyflow/react';
import {
  AlertTriangle,
  CheckCircle2,
  Image,
  Info,
  Loader2,
  RefreshCw,
  SlidersHorizontal,
  Sparkles,
} from 'lucide-react';
import { getTopazStatus, runTopazGigapixel, type TopazStatus } from '../../services/topaz';
import { fileNameFromUrl, getMediaItemsFromData, type MediaItem } from '../../utils/mediaCollection';
import { useRunTrigger } from '../../hooks/useRunTrigger';
import { requestCanvasNodeRun } from '../../utils/canvasRunRequest';
import { useUpdateNodeData } from './useUpdateNodeData';
import { useHasAutoOutput } from './useHasAutoOutput';
import SmartImage from '../SmartImage';

const GIGAPIXEL_MODELS = [
  { value: 'std', label: 'Standard 标准' },
  { value: 'fidelity', label: 'High Fidelity 高保真' },
  { value: 'lowres', label: 'Low Resolution 低清修复' },
  { value: 'recovery', label: 'Recover 严重修复' },
  { value: 'art', label: 'Art & CG 插画 CG' },
  { value: 'lines', label: 'Lines 线稿' },
  { value: 'vc', label: 'Very Compressed 压缩图' },
  { value: 'text', label: 'Text & Shapes 文字图形' },
  { value: 'redefine', label: 'Redefine 重定义' },
];

const DEFAULT_GIGAPIXEL_PATH = 'C:\\Program Files\\Topaz Labs LLC\\Topaz Gigapixel AI\\gigapixel.exe';

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

function statusLabel(status: TopazStatus | null, loading: boolean) {
  if (loading) return '检测中';
  if (!status) return '待检测';
  return status.gigapixel.installed ? '已检测' : '未检测到';
}

function collectUpstreamImages(id: string, edges: any[], nodes: any[]): MediaItem[] {
  const upstreamIds = edges.filter((edge) => edge.target === id).map((edge) => edge.source);
  const seen = new Set<string>();
  const out: MediaItem[] = [];
  for (const sourceId of upstreamIds) {
    const node = nodes.find((item) => item.id === sourceId);
    for (const item of getMediaItemsFromData(node?.data || {}, 'image')) {
      if (!item.url || seen.has(item.url)) continue;
      seen.add(item.url);
      out.push(item);
    }
  }
  return out;
}

function TopazImageUpscaleNode({ id, data, selected }: { id: string; data: any; selected?: boolean }) {
  const update = useUpdateNodeData(id);
  const edges = useEdges();
  const nodes = useNodes();
  const hasAutoOutput = useHasAutoOutput(id);
  const [status, setStatus] = useState<TopazStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);
  const [localError, setLocalError] = useState('');

  const d = data || {};
  const executablePath = typeof d.topazGigapixelPath === 'string' ? d.topazGigapixelPath : '';
  const model = typeof d.topazGigapixelModel === 'string' ? d.topazGigapixelModel : 'std';
  const scale = Number(d.topazGigapixelScale ?? 2);
  const enableSettings = d.topazGigapixelEnableSettings !== false;
  const denoise = Number(d.topazGigapixelDenoise ?? 1);
  const sharpen = Number(d.topazGigapixelSharpen ?? 1);
  const compression = Number(d.topazGigapixelCompression ?? 67);
  const fineDetail = Number(d.topazGigapixelFineDetail ?? 50);
  const preDownscaling = Number(d.topazGigapixelPreDownscaling ?? 75);
  const showAdvanced = d.topazGigapixelShowAdvanced === true;
  const statusText = d.status || 'idle';
  const outputUrls: string[] = Array.isArray(d.imageUrls) && d.imageUrls.length > 0
    ? d.imageUrls
    : d.imageUrl
      ? [d.imageUrl]
      : [];

  const upstreamImages = useMemo(
    () => collectUpstreamImages(id, edges, nodes),
    [id, edges, nodes, data],
  );
  const inputImage = upstreamImages[0]?.url || '';

  const refreshStatus = async () => {
    setStatusLoading(true);
    try {
      setStatus(await getTopazStatus({ gigapixelPath: executablePath || undefined }));
    } catch (error: any) {
      setStatus({
        gigapixel: {
          installed: false,
          defaultExecutablePath: DEFAULT_GIGAPIXEL_PATH,
          setupHints: [error?.message || 'Topaz 状态检查失败'],
        },
        video: { installed: false, setupHints: [] },
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
    if (!inputImage) {
      const msg = '请连接上游图像素材';
      setLocalError(msg);
      update({ status: 'error', error: msg });
      return;
    }
    update({ status: 'running', error: '', imageUrl: '', imageUrls: [], urls: [] });
    try {
      const result = await runTopazGigapixel({
        imageUrl: inputImage,
        executablePath: executablePath || undefined,
        model,
        scale,
        enableSettings,
        denoise,
        sharpen,
        compression,
        fineDetail,
        preDownscaling,
      });
      const urls = result.outputUrls?.length ? result.outputUrls : [result.outputUrl];
      update({
        status: 'success',
        error: '',
        imageUrl: urls[0],
        imageUrls: urls,
        urls,
        fileName: result.fileName || fileNameFromUrl(urls[0]),
        fileSize: result.size || 0,
        mime: result.mime || 'image/png',
        topazGigapixelResult: result,
        metadata: { ...(d.metadata || {}), topazGigapixelResult: result },
      });
    } catch (error: any) {
      const msg = error?.message || 'Topaz 图像高清化失败';
      setLocalError(msg);
      update({ status: 'error', error: msg });
    }
  };

  useRunTrigger(id, handleRun, 'topaz-image-upscale');

  const error = localError || d.error || '';
  const installed = status?.gigapixel.installed === true;

  return (
    <div
      className={`t8-node overflow-hidden ${selected ? 'ring-2' : ''}`}
      style={{
        width: 390,
        borderColor: selected ? 'var(--t8-accent)' : 'var(--t8-border-strong)',
        boxShadow: selected ? '0 0 0 2px color-mix(in srgb, var(--t8-accent) 32%, transparent)' : undefined,
      }}
    >
      <Handle type="target" position={Position.Left} style={{ background: '#f59e0b', border: '1px solid var(--t8-bg-node)' }} />
      <Handle type="source" position={Position.Right} style={{ background: '#f59e0b', border: '1px solid var(--t8-bg-node)' }} />

      <div className="t8-node-header flex items-center gap-2 px-3 py-2">
        <div className="flex h-8 w-8 items-center justify-center rounded-md" style={{ background: '#f59e0b', color: '#1b1303' }}>
          <Image size={17} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-bold">Topaz图像高清化</div>
          <div className="truncate text-[10px]" style={{ color: 'var(--t8-text-muted)' }}>
            Gigapixel · {scale}x · {GIGAPIXEL_MODELS.find((item) => item.value === model)?.label || model}
          </div>
        </div>
        <div className="flex items-center gap-1 text-[10px] font-bold" style={{ color: installed ? '#16a34a' : 'var(--t8-text-dim)' }}>
          {installed ? <CheckCircle2 size={12} /> : <AlertTriangle size={12} />}
          {statusLabel(status, statusLoading)}
        </div>
      </div>

      <div className="nodrag nowheel space-y-2 p-3" onMouseDown={(event) => event.stopPropagation()}>
        <div className="t8-card flex items-start gap-2 px-2 py-2">
          <Info size={14} style={{ color: '#f59e0b' }} />
          <div className="min-w-0 flex-1">
            <div className="text-[11px] font-semibold">需要本机已安装并登录 Topaz Gigapixel AI / Gigapixel 8。</div>
            <SmallHint>本节点只调用本地软件，不随 T8 内置 Topaz；若默认路径不对，可填写 gigapixel.exe。</SmallHint>
          </div>
        </div>

        {inputImage ? (
          <div className="grid grid-cols-[82px_1fr] gap-2 rounded-md border p-2" style={{ borderColor: 'var(--t8-border)' }}>
            <SmartImage src={inputImage} alt="input" className="h-20 w-full rounded object-cover" thumbSize={240} />
            <div className="min-w-0">
              <FieldLabel>输入图像</FieldLabel>
              <div className="truncate text-[11px] font-semibold" style={{ color: 'var(--t8-text-main)' }}>{upstreamImages[0]?.name || fileNameFromUrl(inputImage)}</div>
              <SmallHint>{upstreamImages.length > 1 ? `检测到 ${upstreamImages.length} 张图，当前处理第 1 张。` : '连接上游上传素材、资源库图像或图像输出。'}</SmallHint>
            </div>
          </div>
        ) : (
          <div className="rounded-md border border-dashed px-3 py-4 text-center text-[11px]" style={{ borderColor: 'var(--t8-border)', color: 'var(--t8-text-dim)' }}>
            连接一张图像后运行高清化
          </div>
        )}

        <div className="grid grid-cols-2 gap-2">
          <div>
            <FieldLabel>模型</FieldLabel>
            <select className="t8-select w-full px-2 py-1.5 text-xs" value={model} onChange={(event) => update({ topazGigapixelModel: event.target.value })}>
              {GIGAPIXEL_MODELS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
            </select>
          </div>
          <div>
            <FieldLabel>倍数</FieldLabel>
            <select className="t8-select w-full px-2 py-1.5 text-xs" value={scale} onChange={(event) => update({ topazGigapixelScale: Number(event.target.value) })}>
              {[1, 1.5, 2, 3, 4, 6].map((item) => <option key={item} value={item}>{item}x</option>)}
            </select>
          </div>
        </div>

        <div className="space-y-1">
          <FieldLabel>Gigapixel 路径（可选）</FieldLabel>
          <input
            className="t8-input nodrag w-full px-2 py-1.5 text-[11px]"
            value={executablePath}
            placeholder={status?.gigapixel.defaultExecutablePath || DEFAULT_GIGAPIXEL_PATH}
            onChange={(event) => update({ topazGigapixelPath: event.target.value })}
          />
          <SmallHint>{status?.gigapixel.source ? `检测来源：${status.gigapixel.source}` : '留空会自动尝试默认安装路径与 PATH。'}</SmallHint>
        </div>

        <div className="grid grid-cols-[1fr_auto] gap-2">
          <button type="button" className="t8-btn px-2 py-1.5 text-xs" onClick={refreshStatus} disabled={statusLoading}>
            {statusLoading ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
            检测本机
          </button>
          <button type="button" className="t8-btn px-2 py-1.5 text-xs" onClick={() => update({ topazGigapixelShowAdvanced: !showAdvanced })}>
            <SlidersHorizontal size={13} />
            高级
          </button>
        </div>

        {showAdvanced && (
          <div className="grid grid-cols-2 gap-2 rounded-md border p-2" style={{ borderColor: 'var(--t8-border)' }}>
            <ToggleRow label="启用增强参数" checked={enableSettings} onChange={(value) => update({ topazGigapixelEnableSettings: value })} />
            <div />
            <div>
              <FieldLabel>降噪</FieldLabel>
              <NumberInput value={denoise} min={0} max={100} step={1} onChange={(value) => update({ topazGigapixelDenoise: value })} />
            </div>
            <div>
              <FieldLabel>锐化</FieldLabel>
              <NumberInput value={sharpen} min={0} max={100} step={1} onChange={(value) => update({ topazGigapixelSharpen: value })} />
            </div>
            <div>
              <FieldLabel>压缩修复</FieldLabel>
              <NumberInput value={compression} min={0} max={100} step={1} onChange={(value) => update({ topazGigapixelCompression: value })} />
            </div>
            <div>
              <FieldLabel>细节保留</FieldLabel>
              <NumberInput value={fineDetail} min={0} max={100} step={1} onChange={(value) => update({ topazGigapixelFineDetail: value })} />
            </div>
            <div className="col-span-2">
              <FieldLabel>Recover 预降采样</FieldLabel>
              <NumberInput value={preDownscaling} min={50} max={100} step={1} onChange={(value) => update({ topazGigapixelPreDownscaling: value })} />
              <SmallHint>仅 Recover 模型生效，对齐 ComfyUI-GigapixelAI 的 --pds 参数。</SmallHint>
            </div>
          </div>
        )}

        <button type="button" className="t8-btn t8-btn-primary w-full px-3 py-2 text-sm" onClick={() => requestCanvasNodeRun(id)} disabled={statusText === 'running'}>
          {statusText === 'running' ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
          {statusText === 'running' ? '处理中...' : '运行图像高清化'}
        </button>

        {error && (
          <div className="rounded-md border px-2 py-1.5 text-[11px] whitespace-pre-wrap" style={{ borderColor: '#ef444466', color: '#ef4444' }}>
            {error}
          </div>
        )}

        {!hasAutoOutput && outputUrls.length > 0 && (
          <div className="grid grid-cols-2 gap-2">
            {outputUrls.slice(0, 4).map((url) => (
              <SmartImage key={url} src={url} alt="topaz result" className="h-28 w-full rounded object-cover" thumbSize={360} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default memo(TopazImageUpscaleNode);
