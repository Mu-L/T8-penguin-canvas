import { memo, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import {
  Handle, Position, useNodeConnections, useNodesData, useUpdateNodeInternals, type NodeProps,
} from '@xyflow/react';
import {
  Camera, CheckCircle2, ExternalLink, ImagePlus, Layers3, Loader2, ScanFace, Sparkles, X,
} from 'lucide-react';
import { PORT_COLOR } from '../../config/portTypes';
import { useThemeStore } from '../../stores/theme';
import { uploadDataUrl, uploadFileBlob } from '../../services/imageOps';
import { useRunTrigger } from '../../hooks/useRunTrigger';
import { requestCanvasNodeRun } from '../../utils/canvasRunRequest';
import {
  applyFaceCameraPreset,
  applyFacePreset,
  applyPhotoCalibration,
  buildFaceBatchPlan,
  defaultFaceExpressionState,
  faceExpressionMetadata,
  normalizeFaceExpressionState,
  type FaceExpression3DState,
} from '../../utils/faceExpression3D';
import { analyzeFacePhoto } from '../../utils/facePhotoAnalysis';
import FaceExpressionViewport, { type FaceExpressionViewportHandle } from '../face-expression-3d/FaceExpressionViewport';
import FaceExpression3DEditor from '../face-expression-3d/FaceExpression3DEditor';
import ResizableCorners from './ResizableCorners';
import { useUpdateNodeData } from './useUpdateNodeData';
import { useUpstreamMaterials } from './useUpstreamMaterials';

const handleStyle: CSSProperties = { width: 12, height: 12, border: 'none', zIndex: 20 };
const MODEL_RE = /\.(glb|gltf)(?:\?|#|$)/i;

function collectModelUrl(data: any): string {
  const values = [data?.modelUrl, data?.directModelUrl, ...(Array.isArray(data?.modelUrls) ? data.modelUrls : []), ...(Array.isArray(data?.directModelUrls) ? data.directModelUrls : [])];
  return values.find((value) => typeof value === 'string' && (MODEL_RE.test(value) || /^data:model\/gltf/i.test(value))) || '';
}

function collectFaceMetadata(data: any): any {
  const candidates = [data?.faceExpressionMetadata, data?.metadata, data?.portraitMetadata, data?.outputMetadata];
  return candidates.find((item) => item && typeof item === 'object' && (item.schema === 't8-face-expression-state' || item.expression || item.model)) || null;
}

function outputPrefix(state: FaceExpression3DState, suffix = '') {
  const preset = state.expression.presetId || 'custom';
  return `face-expression-${preset}${suffix ? `-${suffix}` : ''}`.replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 72);
}

const FaceExpression3DNode = ({ id, data, selected }: NodeProps) => {
  const d = (data || {}) as any;
  const update = useUpdateNodeData(id);
  const updateNodeInternals = useUpdateNodeInternals();
  const { theme, style: themeStyle } = useThemeStore();
  const isDark = theme === 'dark';
  const isPixel = themeStyle === 'pixel';
  const state = useMemo(() => normalizeFaceExpressionState(d.faceExpression3DState || defaultFaceExpressionState()), [d.faceExpression3DState]);
  const stateRef = useRef(state);
  const viewportRef = useRef<FaceExpressionViewportHandle | null>(null);
  const photoInputRef = useRef<HTMLInputElement | null>(null);
  const cancelRef = useRef(0);
  const upstream = useUpstreamMaterials(id);
  const connections = useNodeConnections({ id, handleType: 'target' });
  const upstreamIds = useMemo(() => Array.from(new Set(connections.map((item) => item.source).filter(Boolean))), [connections]);
  const upstreamNodes = useNodesData(upstreamIds);
  const upstreamModelUrl = useMemo(() => (Array.isArray(upstreamNodes) ? upstreamNodes.map((node: any) => collectModelUrl(node?.data)).find(Boolean) : '') || '', [upstreamNodes]);
  const upstreamMetadata = useMemo(() => (Array.isArray(upstreamNodes) ? upstreamNodes.map((node: any) => collectFaceMetadata(node?.data)).find(Boolean) : null), [upstreamNodes]);
  const [editorOpen, setEditorOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [message, setMessage] = useState(d.error || '拖动预览旋转，点击编辑进入完整工作台');
  const [photoMessage, setPhotoMessage] = useState('');
  const [batchProgress, setBatchProgress] = useState<{ completed: number; total: number } | null>(null);
  const [size, setSize] = useState(() => d?.size && Number(d.size.w) > 0 ? { w: Number(d.size.w), h: Number(d.size.h) } : { w: 520, h: 520 });

  stateRef.current = state;

  useEffect(() => {
    if (!upstreamModelUrl || state.model.sourceUrl === upstreamModelUrl) return;
    const next = normalizeFaceExpressionState({ ...state, model: { ...state.model, source: 'upstream', sourceUrl: upstreamModelUrl, adapterId: 'semantic-morph-v1' } });
    update({ faceExpression3DState: next });
  }, [upstreamModelUrl]);

  const changeState = (next: FaceExpression3DState) => {
    stateRef.current = next;
    update({ faceExpression3DState: next, error: '' });
  };

  const writeOutputs = (urls: string[], outputState: FaceExpression3DState, extra: Record<string, any> = {}) => {
    const last = urls[urls.length - 1] || '';
    update({
      status: 'success', taskStatus: 'completed', error: '', imageUrl: last, directImageUrl: last,
      imageUrls: urls, directImageUrls: urls, urls,
      metadata: faceExpressionMetadata(outputState, last),
      faceExpressionMetadata: faceExpressionMetadata(outputState, last),
      outputText: '',
      ...extra,
    });
  };

  const runSingle = async (viewport = viewportRef.current) => {
    if (!viewport || busy) return;
    const token = ++cancelRef.current;
    setBusy(true);
    setMessage('正在按目标像素渲染...');
    update({ status: 'running', taskStatus: 'running', error: '' });
    try {
      await viewport.setState(stateRef.current);
      const dataUrl = await viewport.exportImage(stateRef.current.output);
      if (token !== cancelRef.current) throw new Error('已停止生成');
      const url = await uploadDataUrl(dataUrl, outputPrefix(stateRef.current));
      if (token !== cancelRef.current) throw new Error('已停止生成');
      writeOutputs([url], stateRef.current);
      setMessage(`已生成 ${stateRef.current.output.width}×${stateRef.current.output.height}`);
    } catch (error) {
      const text = error instanceof Error ? error.message : '3D 表情图片生成失败';
      if (text !== '已停止生成') update({ status: 'error', taskStatus: 'failed', error: text });
      setMessage(text);
      throw error;
    } finally {
      if (token === cancelRef.current) setBusy(false);
    }
  };

  const runBatch = async (viewport = viewportRef.current) => {
    if (!viewport || busy) return;
    const baseState = stateRef.current;
    const plan = buildFaceBatchPlan(baseState);
    if (!plan.length) return;
    const token = ++cancelRef.current;
    const urls: string[] = [];
    setBusy(true);
    setBatchProgress({ completed: 0, total: plan.length });
    setMessage(`批量渲染 0/${plan.length}`);
    update({ status: 'running', taskStatus: 'running', error: '' });
    try {
      for (const item of plan) {
        if (token !== cancelRef.current) throw new Error('已停止生成');
        const itemState = applyFaceCameraPreset(applyFacePreset(baseState, item.expressionPresetId, 'replace'), item.cameraPresetId);
        await viewport.setState(itemState);
        const dataUrl = await viewport.exportImage(itemState.output);
        if (token !== cancelRef.current) throw new Error('已停止生成');
        urls.push(await uploadDataUrl(dataUrl, outputPrefix(itemState, item.fileLabel)));
        setBatchProgress({ completed: urls.length, total: plan.length });
        setMessage(`批量渲染 ${urls.length}/${plan.length}`);
      }
      await viewport.setState(baseState);
      writeOutputs(urls, baseState, { faceExpressionBatch: plan });
      setMessage(`批量完成，共 ${urls.length} 张`);
    } catch (error) {
      await viewport.setState(baseState).catch(() => undefined);
      const text = error instanceof Error ? error.message : '批量导出失败';
      if (urls.length) writeOutputs(urls, baseState, { warning: `${text}，已保留 ${urls.length} 张` });
      else if (text !== '已停止生成') update({ status: 'error', taskStatus: 'failed', error: text });
      setMessage(text);
      if (text !== '已停止生成') throw error;
    } finally {
      if (token === cancelRef.current) setBusy(false);
      setBatchProgress(null);
    }
  };

  const stop = () => {
    cancelRef.current += 1;
    setBusy(false);
    setBatchProgress(null);
    setMessage('已停止；下次运行会创建全新的渲染任务');
    update({ status: 'idle', taskStatus: 'cancelled', error: '' });
  };

  const analyzeFile = async (file: File) => {
    setPhotoBusy(true);
    setPhotoMessage('正在上传并分析 478 点人脸...');
    try {
      const url = await uploadFileBlob(file, `face-reference-${Date.now()}-${file.name}`);
      const result = await analyzeFacePhoto(url);
      const next = applyPhotoCalibration(stateRef.current, result.calibration, result.blendshapes);
      changeState(next);
      setPhotoMessage(`已检测 ${result.landmarkCount} 个关键点并校准；${result.warnings.join('；') || '可继续微调'}`);
    } catch (error) {
      setPhotoMessage(error instanceof Error ? error.message : '人物脸部图片分析失败');
    } finally {
      setPhotoBusy(false);
    }
  };

  const analyzeUpstream = async () => {
    const image = upstream.images[0]?.url;
    if (!image) {
      photoInputRef.current?.click();
      return;
    }
    setPhotoBusy(true);
    setPhotoMessage('正在分析上游人物图片...');
    try {
      const result = await analyzeFacePhoto(image);
      changeState(applyPhotoCalibration(stateRef.current, result.calibration, result.blendshapes));
      setPhotoMessage(`已从上游校准 ${result.landmarkCount} 个关键点`);
    } catch (error) {
      setPhotoMessage(error instanceof Error ? error.message : '上游图片分析失败');
    } finally { setPhotoBusy(false); }
  };

  const applyUpstreamMetadata = () => {
    if (!upstreamMetadata) return;
    const next = normalizeFaceExpressionState({ ...stateRef.current, ...upstreamMetadata, model: { ...stateRef.current.model, ...(upstreamMetadata.model || {}) } });
    changeState(next);
    setMessage('已应用上游表情元数据');
  };

  useRunTrigger(id, () => runSingle(), 'face-expression-3d');

  const accent = '#22d3ee';
  const bg = isPixel ? 'var(--px-surface)' : isDark ? '#0c121a' : '#f8fbfd';
  const surface = isPixel ? 'var(--px-muted)' : isDark ? '#151f2b' : '#e8f4f7';
  const text = isPixel ? 'var(--px-ink)' : isDark ? '#f1f5f9' : '#10212b';
  const sub = isPixel ? 'var(--px-ink-soft)' : isDark ? '#94a3b8' : '#536872';
  const border = isPixel ? 'var(--px-ink)' : isDark ? 'rgba(103,232,249,.25)' : 'rgba(8,145,178,.26)';

  const onResize = (_event: any, params: { width: number; height: number }) => {
    const next = { w: Math.round(params.width), h: Math.round(params.height) };
    setSize(next); update({ size: next }); updateNodeInternals(id);
  };

  return (
    <div className="relative flex flex-col" style={{ width: size.w, height: size.h, minWidth: 420, minHeight: 430, background: bg, color: text, border: `2px solid ${selected ? accent : border}`, borderRadius: isPixel ? 8 : 10, boxShadow: isPixel ? '4px 4px 0 var(--px-ink)' : '0 14px 34px rgba(0,0,0,.22)', overflow: 'visible' }}>
      <Handle id="model3d" type="target" position={Position.Left} style={{ ...handleStyle, top: '35%', left: -7, background: PORT_COLOR.model3d }} title="3D 模型" />
      <Handle id="image" type="target" position={Position.Left} style={{ ...handleStyle, top: '52%', left: -7, background: PORT_COLOR.image }} title="脸部图片" />
      <Handle id="metadata" type="target" position={Position.Left} style={{ ...handleStyle, top: '69%', left: -7, background: PORT_COLOR.metadata }} title="表情元数据" />
      <Handle id="image" type="source" position={Position.Right} style={{ ...handleStyle, top: '45%', right: -7, background: PORT_COLOR.image }} title="图片" />
      <Handle id="metadata" type="source" position={Position.Right} style={{ ...handleStyle, top: '62%', right: -7, background: PORT_COLOR.metadata }} title="表情元数据" />
      <ResizableCorners selected={selected} minWidth={420} minHeight={430} maxWidth={900} maxHeight={900} accent={accent} keepAspectRatio={false} onResize={onResize} onResizeEnd={onResize} />

      <header className="flex h-14 shrink-0 items-center gap-2 border-b px-3" style={{ borderColor: border, background: surface }}>
        <div className="flex h-9 w-9 items-center justify-center rounded-md bg-cyan-400 text-[#071018]"><ScanFace size={19} /></div>
        <div className="min-w-0 flex-1"><div className="truncate text-[15px] font-black">3D表情编辑</div><div className="truncate text-[10px]" style={{ color: sub }}>{state.model.source === 'upstream' ? '自定义 GLB/GLTF · 语义 morph 映射' : 'ICT 中性人类白模 · 52 表情通道'}</div></div>
        {d.status === 'success' && <CheckCircle2 size={16} className="text-emerald-400" />}
      </header>

      <div className="nodrag nowheel relative min-h-[230px] flex-1 overflow-hidden" onMouseDown={(event) => event.stopPropagation()}>
        <FaceExpressionViewport ref={viewportRef} state={state} className="h-full w-full" onStateChange={changeState} onError={setMessage} />
      </div>

      <div className="shrink-0 space-y-2 border-t p-3" style={{ borderColor: border, background: bg }}>
        <div className="grid grid-cols-3 gap-2 text-[10px]">
          <button className="nodrag inline-flex h-9 items-center justify-center gap-1 rounded-md border font-bold" style={{ borderColor: border, background: surface }} onClick={() => setEditorOpen(true)}><ExternalLink size={13} />完整编辑</button>
          <button className="nodrag inline-flex h-9 items-center justify-center gap-1 rounded-md border font-bold" style={{ borderColor: border, background: surface }} onClick={() => void analyzeUpstream()} disabled={photoBusy}>{photoBusy ? <Loader2 size={13} className="animate-spin" /> : <ImagePlus size={13} />}脸部校准</button>
          <button className="nodrag inline-flex h-9 items-center justify-center gap-1 rounded-md border font-bold disabled:opacity-40" style={{ borderColor: border, background: surface }} onClick={applyUpstreamMetadata} disabled={!upstreamMetadata}><Sparkles size={13} />应用参数</button>
        </div>
        <div className="flex items-center gap-2">
          <button className="nodrag inline-flex h-10 flex-1 items-center justify-center gap-2 rounded-md border-2 border-cyan-400 bg-cyan-400/15 text-[12px] font-black" onClick={() => requestCanvasNodeRun(id)} disabled={busy}>{busy ? <Loader2 size={15} className="animate-spin" /> : <Camera size={15} />}生成图片</button>
          <button className="nodrag inline-flex h-10 w-24 items-center justify-center gap-1 rounded-md border text-[11px] font-bold" style={{ borderColor: border, background: surface }} onClick={() => void runBatch()} disabled={busy}><Layers3 size={14} />批量</button>
          {busy && <button className="nodrag inline-flex h-10 w-10 items-center justify-center rounded-md border border-rose-400/60 text-rose-400" onClick={stop} title="停止"><X size={15} /></button>}
        </div>
        <div className="flex items-center justify-between gap-2 text-[10px]" style={{ color: d.error ? '#fb7185' : sub }}><span className="truncate" title={d.error || photoMessage || message}>{d.error || photoMessage || message}</span><strong className="shrink-0" style={{ color: text }}>{state.output.width}×{state.output.height}</strong></div>
      </div>

      <input ref={photoInputRef} className="hidden" type="file" accept="image/*" onChange={(event) => { const file = event.target.files?.[0]; event.currentTarget.value = ''; if (file) void analyzeFile(file); }} />
      {editorOpen && <FaceExpression3DEditor state={state} busy={busy} batchProgress={batchProgress} photoBusy={photoBusy} photoMessage={photoMessage} onChange={changeState} onAnalyzePhoto={analyzeFile} onExport={(viewport) => runSingle(viewport)} onBatchExport={(viewport) => runBatch(viewport)} onStop={stop} onClose={() => setEditorOpen(false)} />}
    </div>
  );
};

export default memo(FaceExpression3DNode);
