import {
  lazy, memo, Suspense, useEffect, useMemo, useRef, useState, type CSSProperties,
} from 'react';
import { createPortal } from 'react-dom';
import {
  Handle, Position, useNodeConnections, useNodesData, useReactFlow, useUpdateNodeInternals, type NodeProps,
} from '@xyflow/react';
import {
  Box, Camera, CheckCircle2, ExternalLink, FileImage, Film, Github, Heart, Loader2,
} from 'lucide-react';
import { PORT_COLOR } from '../../config/portTypes';
import { useThemeStore } from '../../stores/theme';
import { copyFileToOutput, uploadFileBlob } from '../../services/imageOps';
import { useRunTrigger } from '../../hooks/useRunTrigger';
import { createCanvasNodeRunRequestId, requestCanvasNodeRun } from '../../utils/canvasRunRequest';
import { useRunBusStore } from '../../stores/runBus';
import type { PrevisStudioEditorHandle } from '../../features/previs-studio/PrevisStudioEditor';
import ResizableCorners from './ResizableCorners';
import { useUpdateNodeData } from './useUpdateNodeData';

const LazyPrevisStudioEditor = lazy(() => import('../../features/previs-studio/PrevisStudioEditor'));

const SOURCE_URL = 'https://github.com/GuiYi-Xi/monoform-previs-studio';
const SOURCE_COMMIT = '77f4bae83eeee550a6f416757231f438155bf674';
const handleStyle: CSSProperties = { width: 12, height: 12, border: 'none', zIndex: 20 };

type PrevisRunKind = 'image' | 'video';

function collectModelUrl(data: any): string {
  const values = [
    data?.modelUrl,
    data?.directModelUrl,
    ...(Array.isArray(data?.modelUrls) ? data.modelUrls : []),
    ...(Array.isArray(data?.directModelUrls) ? data.directModelUrls : []),
  ];
  return values.find((value) => typeof value === 'string' && /\.(glb|gltf)(?:\?|#|$)/i.test(value)) || '';
}

function normalizeProject(value: any): Record<string, any> | null {
  if (!value || typeof value !== 'object' || !Array.isArray(value.objects)) return null;
  return value;
}

async function persistPrevisOutput(blob: Blob, filename: string): Promise<string> {
  const uploadedUrl = await uploadFileBlob(blob, filename);
  const archived = await copyFileToOutput(uploadedUrl, filename, 'previs');
  if (!archived.url.startsWith('/files/output/previs/')) {
    throw new Error('白模预演输出没有进入受控 output 目录。');
  }
  return archived.url;
}

function hasUnsafeLegacyOutput(data: Record<string, unknown> | undefined, fields: string[]): boolean {
  const values = fields.flatMap((field) => {
    const value = data?.[field];
    return Array.isArray(value) ? value : [value];
  });
  return values.some((value) => {
    const url = typeof value === 'string' ? value.trim() : '';
    return Boolean(url && !url.startsWith('/files/output/') && !url.startsWith('/output/') && !/^https:\/\//i.test(url));
  });
}

function projectSummary(project: Record<string, any> | null) {
  const objects = Array.isArray(project?.objects) ? project!.objects : [];
  const tracks = project?.objectKeyframes && typeof project.objectKeyframes === 'object'
    ? Object.values(project.objectKeyframes).filter((value) => Array.isArray(value) && value.length).length
    : 0;
  const cameraKeys = Array.isArray(project?.keyframes) ? project!.keyframes.length : 0;
  return {
    objectCount: objects.length,
    personCount: objects.filter((item: any) => item?.type === 'person').length,
    animatedTracks: tracks,
    cameraKeys,
    aspectRatio: String(project?.camera?.aspectRatio || '16:9'),
  };
}

const PrevisStudioNode = ({ id, data, selected }: NodeProps) => {
  const d = (data || {}) as any;
  const update = useUpdateNodeData(id);
  const rf = useReactFlow();
  const updateNodeInternals = useUpdateNodeInternals();
  const { theme, style: themeStyle } = useThemeStore();
  const isDark = theme === 'dark';
  const isPixel = themeStyle === 'pixel';
  const project = useMemo(() => normalizeProject(d.previsProject), [d.previsProject]);
  const summary = useMemo(() => projectSummary(project), [project]);
  const editorRef = useRef<PrevisStudioEditorHandle | null>(null);
  const cancelledDuringRunRef = useRef(false);
  const readyWaitersRef = useRef(new Set<() => void>());
  const connections = useNodeConnections({ id, handleType: 'target' });
  const upstreamIds = useMemo(() => Array.from(new Set(connections.map((item) => item.source).filter(Boolean))), [connections]);
  const upstreamNodes = useNodesData(upstreamIds);
  const upstreamModelUrl = useMemo(
    () => (Array.isArray(upstreamNodes) ? upstreamNodes.map((node: any) => collectModelUrl(node?.data)).find(Boolean) : '') || '',
    [upstreamNodes],
  );
  const [editorOpen, setEditorOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(d.error || '打开工作台摆放人物、场景与镜头');
  const [size, setSize] = useState(() => d?.size && Number(d.size.w) > 0
    ? { w: Number(d.size.w), h: Number(d.size.h) }
    : { w: 500, h: 460 });
  const cancelSeq = useRunBusStore((state) => state.cancelSeq);
  const cancelTargets = useRunBusStore((state) => state.cancelTargets);

  useEffect(() => {
    if (!cancelTargets.includes(id)) return;
    cancelledDuringRunRef.current = true;
    editorRef.current?.cancelExport();
    setMessage('白模预演导出已停止');
  }, [cancelSeq, cancelTargets, id]);

  useEffect(() => {
    if (!upstreamModelUrl || d.previsUpstreamModelUrl === upstreamModelUrl) return;
    const base = project || {
      version: 8,
      objects: [],
      camera: { position: [7.4, 4.6, 8.2], target: [0.2, 1.2, 0], focalLength: 42, aspectRatio: '16:9' },
      keyframes: [],
      objectKeyframes: {},
    };
    const modelId = `upstream-model-${id}`;
    const objects = [
      ...base.objects.filter((item: any) => item?.id !== modelId),
      {
        id: modelId,
        name: '上游 3D 模型',
        type: 'model',
        url: upstreamModelUrl,
        position: [0, 0, 0],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
        color: '#ddd8cc',
      },
    ];
    update({ previsProject: { ...base, objects }, previsUpstreamModelUrl: upstreamModelUrl });
  }, [upstreamModelUrl, d.previsUpstreamModelUrl, project]);

  const onEditorReady = () => {
    for (const resolve of readyWaitersRef.current) resolve();
    readyWaitersRef.current.clear();
  };

  const ensureEditorReady = async () => {
    if (editorRef.current) return editorRef.current;
    setEditorOpen(true);
    await new Promise<void>((resolve, reject) => {
      const finish = () => {
        window.clearTimeout(timer);
        resolve();
      };
      const timer = window.setTimeout(() => {
        readyWaitersRef.current.delete(finish);
        reject(new Error('白模预演工作台加载超时，请关闭后重试。'));
      }, 15_000);
      readyWaitersRef.current.add(finish);
    });
    if (!editorRef.current) throw new Error('白模预演工作台尚未就绪。');
    return editorRef.current;
  };

  const writeProject = (nextProject: Record<string, unknown>) => {
    const liveData = rf.getNode(id)?.data as Record<string, unknown> | undefined;
    const currentRevision = Number(liveData?.previsProjectRevision || 0);
    update({
      previsProject: nextProject,
      previsProjectRevision: currentRevision + 1,
      previsSource: { repository: SOURCE_URL, commit: SOURCE_COMMIT, author: 'GuiYi-Xi' },
      error: '',
    });
  };

  const requestRun = (kind: PrevisRunKind) => {
    const requestId = createCanvasNodeRunRequestId(id, `previs-${kind}`);
    update({ previsRunKind: kind, previsRunRequestId: requestId, error: '' });
    window.requestAnimationFrame(() => {
      if (requestCanvasNodeRun(id, { requestId })) return;
      const liveData = rf.getNode(id)?.data as Record<string, unknown> | undefined;
      if (liveData?.previsRunRequestId !== requestId) return;
      update({
        previsRunRequestId: '',
        status: 'error',
        taskStatus: 'failed',
        error: '无法提交白模预演运行请求，请重试。',
      });
    });
  };

  useRunTrigger(id, async (reporter) => {
    const liveData = rf.getNode(id)?.data as Record<string, unknown> | undefined;
    const contextRequestId = String(reporter.runContext?.requestId || '').trim();
    const persistedRequestId = String(liveData?.previsRunRequestId || '').trim();
    const kind = String(persistedRequestId ? liveData?.previsRunKind || 'image' : 'image') as PrevisRunKind;
    if (persistedRequestId && contextRequestId !== persistedRequestId) {
      throw new Error('白模预演运行请求已过期或被修改，已停止输出。');
    }
    if (kind !== 'image' && kind !== 'video') throw new Error('白模预演运行类型无效。');
    setBusy(true);
    cancelledDuringRunRef.current = false;
    setMessage(kind === 'video' ? '正在渲染并编码 H.264 MP4…' : '正在渲染当前摄像机画面…');
    update({ status: 'running', taskStatus: 'running', error: '' });
    try {
      const editor = await ensureEditorReady();
      const projectSnapshot = editor.getProject();
      if (projectSnapshot) writeProject(projectSnapshot);
      const revision = Number((rf.getNode(id)?.data as any)?.previsProjectRevision || 0) + 1;
      const assertRunActive = () => {
        if (!cancelledDuringRunRef.current) return;
        const error = new Error('白模预演导出已停止');
        (error as Error & { code?: string }).code = 'PREVIS_EXPORT_CANCELLED';
        throw error;
      };
      if (kind === 'video') {
        const result = await editor.exportVideo();
        assertRunActive();
        const filename = `previs-${id}-${Date.now()}.mp4`;
        const url = await persistPrevisOutput(result.blob, filename);
        assertRunActive();
        const outputText = `白模预演参考动画，${result.durationSeconds.toFixed(2)} 秒，${result.aspectRatio}，${result.fps} FPS。`;
        const metadata = {
          schema: 't8-previs-output-v1', kind: 'video', role: 'motion_camera_reference', url,
          width: result.width, height: result.height, fps: result.fps, frameCount: result.frameCount,
          durationSeconds: result.durationSeconds, aspectRatio: result.aspectRatio, codec: result.codec,
          pixelFormat: 'yuv420p', hasAudio: false, projectRevision: revision,
          source: { repository: SOURCE_URL, commit: SOURCE_COMMIT, author: 'GuiYi-Xi' },
        };
        const nodeBeforeWrite = rf.getNode(id)?.data as Record<string, unknown> | undefined;
        const clearLegacyImage = hasUnsafeLegacyOutput(nodeBeforeWrite, ['imageUrl', 'imageUrls', 'urls', 'directImageUrl', 'directImageUrls']);
        update({
          status: 'success', taskStatus: 'completed', error: '',
          videoUrl: url, videoUrls: [url], directVideoUrl: url, directVideoUrls: [url],
          ...(clearLegacyImage ? { imageUrl: '', imageUrls: [], urls: [], directImageUrl: '', directImageUrls: [] } : {}),
          outputText,
          metadata, previsOutputMetadata: metadata,
        });
        await reporter.output({
          status: 'succeeded',
          outputCount: 2,
          assets: [
            { kind: 'video', sourceUrl: url, filename, mimeType: 'video/mp4', metadata: { ...metadata, role: 'motion_camera_reference' } },
            { kind: 'text', text: outputText, filename: `${filename}.txt`, mimeType: 'text/plain', metadata: { role: 'shot_description' } },
          ],
        });
        setMessage(`动画已落盘 · ${result.width}×${result.height} · ${result.frameCount} 帧`);
      } else {
        const result = await editor.exportImage();
        assertRunActive();
        const filename = `previs-${id}-frame-${result.frame}-${Date.now()}.png`;
        const url = await persistPrevisOutput(result.blob, filename);
        assertRunActive();
        const outputText = `白模预演构图参考，第 ${result.frame} 帧，${result.aspectRatio}。`;
        const metadata = {
          schema: 't8-previs-output-v1', kind: 'image', role: 'composition_reference', url,
          width: result.width, height: result.height, frame: result.frame, fps: result.fps,
          timeSeconds: result.frame / result.fps, aspectRatio: result.aspectRatio,
          projectRevision: revision,
          source: { repository: SOURCE_URL, commit: SOURCE_COMMIT, author: 'GuiYi-Xi' },
        };
        const nodeBeforeWrite = rf.getNode(id)?.data as Record<string, unknown> | undefined;
        const clearLegacyVideo = hasUnsafeLegacyOutput(nodeBeforeWrite, ['videoUrl', 'videoUrls', 'directVideoUrl', 'directVideoUrls']);
        update({
          status: 'success', taskStatus: 'completed', error: '',
          imageUrl: url, imageUrls: [url], urls: [url], directImageUrl: url, directImageUrls: [url],
          ...(clearLegacyVideo ? { videoUrl: '', videoUrls: [], directVideoUrl: '', directVideoUrls: [] } : {}),
          outputText,
          metadata, previsOutputMetadata: metadata,
        });
        await reporter.output({
          status: 'succeeded',
          outputCount: 2,
          assets: [
            { kind: 'image', sourceUrl: url, filename, mimeType: 'image/png', metadata: { ...metadata, role: 'composition_reference' } },
            { kind: 'text', text: outputText, filename: `${filename}.txt`, mimeType: 'text/plain', metadata: { role: 'shot_description' } },
          ],
        });
        setMessage(`当前帧已落盘 · ${result.width}×${result.height}`);
      }
    } catch (error) {
      const text = error instanceof Error ? error.message : '白模预演导出失败';
      const cancelled = cancelledDuringRunRef.current
        || (error as Error & { code?: string } | null)?.code === 'PREVIS_EXPORT_CANCELLED';
      update(cancelled
        ? { status: 'stopped', taskStatus: 'cancelled', error: '' }
        : { status: 'error', taskStatus: 'failed', error: text });
      setMessage(text);
      throw error;
    } finally {
      setBusy(false);
      if (contextRequestId) {
        const latest = rf.getNode(id)?.data as Record<string, unknown> | undefined;
        if (latest?.previsRunRequestId === contextRequestId) update({ previsRunRequestId: '' });
      }
    }
  }, 'previs-studio', { lifecycleAware: true });

  const openSource = () => {
    if (window.t8pc?.openExternal) void window.t8pc.openExternal(SOURCE_URL);
    else window.open(SOURCE_URL, '_blank', 'noopener,noreferrer');
  };

  const onResize = (_event: any, params: { width: number; height: number }) => {
    const next = { w: Math.round(params.width), h: Math.round(params.height) };
    setSize(next);
    update({ size: next });
    updateNodeInternals(id);
  };

  const accent = '#d6a84f';
  const bg = isPixel ? 'var(--px-surface)' : isDark ? '#171716' : '#f6f2e8';
  const surface = isPixel ? 'var(--px-muted)' : isDark ? '#242422' : '#ebe3d2';
  const text = isPixel ? 'var(--px-ink)' : isDark ? '#ece9e0' : '#2b2417';
  const sub = isPixel ? 'var(--px-ink-soft)' : isDark ? '#a6a49c' : '#6f685d';
  const border = isPixel ? 'var(--px-ink)' : isDark ? 'rgba(214,168,79,.32)' : 'rgba(122,83,20,.28)';

  return (
    <div className="relative flex flex-col" style={{ width: size.w, height: size.h, minWidth: 430, minHeight: 410, background: bg, color: text, border: `2px solid ${selected ? accent : border}`, borderRadius: isPixel ? 8 : 14, boxShadow: isPixel ? '4px 4px 0 var(--px-ink)' : '0 18px 44px rgba(0,0,0,.28)', overflow: 'visible' }}>
      <Handle id="model3d" type="target" position={Position.Left} style={{ ...handleStyle, top: '52%', left: -7, background: PORT_COLOR.model3d }} title="GLB / GLTF 模型" />
      <Handle id="image" type="source" position={Position.Right} style={{ ...handleStyle, top: '39%', right: -7, background: PORT_COLOR.image }} title="预演静帧" />
      <Handle id="video" type="source" position={Position.Right} style={{ ...handleStyle, top: '54%', right: -7, background: PORT_COLOR.video }} title="预演动画" />
      <Handle id="text" type="source" position={Position.Right} style={{ ...handleStyle, top: '69%', right: -7, background: PORT_COLOR.text }} title="镜头说明" />
      <Handle id="metadata" type="source" position={Position.Right} style={{ ...handleStyle, top: '84%', right: -7, background: PORT_COLOR.metadata }} title="预演工程元数据" />
      <ResizableCorners selected={selected} minWidth={430} minHeight={410} maxWidth={900} maxHeight={900} accent={accent} keepAspectRatio={false} onResize={onResize} onResizeEnd={onResize} />

      <header className="flex h-16 shrink-0 items-center gap-3 border-b px-3" style={{ borderColor: border, background: surface }}>
        <div className="flex h-10 w-10 items-center justify-center rounded-lg" style={{ background: accent, color: '#2b2417' }}><Box size={21} /></div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[16px] font-black">白模预演</div>
          <div className="truncate text-[10px]" style={{ color: sub }}>人物摆姿 · 场景粗模 · 相机与关键帧动画</div>
        </div>
        {d.status === 'success' && <CheckCircle2 size={17} className="text-emerald-400" />}
      </header>

      <div className="relative min-h-[190px] flex-1 overflow-hidden" style={{ background: isDark ? '#555653' : '#c7c4bd' }}>
        {d.imageUrl ? (
          <img src={d.imageUrl} alt="白模预演当前输出" className="h-full w-full object-cover" draggable={false} />
        ) : (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3" style={{ color: isDark ? '#e7e3d9' : '#423d35' }}>
            <div className="relative flex h-24 w-36 items-center justify-center rounded-lg border" style={{ borderColor: 'rgba(255,255,255,.34)', background: 'rgba(0,0,0,.16)' }}>
              <Camera size={40} strokeWidth={1.3} />
              <span className="absolute inset-3 border border-dashed border-amber-300/50" />
            </div>
            <span className="text-[11px] font-semibold">打开工作台创建第一张预演画面</span>
          </div>
        )}
        <div className="absolute bottom-2 left-2 right-2 grid grid-cols-4 gap-1 rounded-lg border px-2 py-1.5 text-center text-[9px] backdrop-blur" style={{ borderColor: 'rgba(255,255,255,.16)', background: 'rgba(20,20,18,.72)', color: '#d8d3c8' }}>
          <span>{summary.objectCount} 对象</span><span>{summary.personCount} 人物</span><span>{summary.animatedTracks + summary.cameraKeys} 关键轨</span><span>{summary.aspectRatio}</span>
        </div>
      </div>

      <div className="shrink-0 space-y-2 border-t p-3" style={{ borderColor: border, background: bg }}>
        <div className="grid grid-cols-3 gap-2">
          <button className="nodrag inline-flex h-10 items-center justify-center gap-1 rounded-md border text-[11px] font-bold" style={{ borderColor: border, background: surface }} onClick={() => setEditorOpen(true)}><ExternalLink size={14} />完整工作台</button>
          <button className="nodrag inline-flex h-10 items-center justify-center gap-1 rounded-md border text-[11px] font-bold" style={{ borderColor: border, background: surface }} onClick={() => requestRun('image')} disabled={busy}>{busy ? <Loader2 size={14} className="animate-spin" /> : <FileImage size={14} />}当前帧</button>
          <button className="nodrag inline-flex h-10 items-center justify-center gap-1 rounded-md border text-[11px] font-bold" style={{ borderColor: border, background: surface }} onClick={() => requestRun('video')} disabled={busy}>{busy ? <Loader2 size={14} className="animate-spin" /> : <Film size={14} />}预演动画</button>
        </div>
        <button className="nodrag flex h-8 w-full items-center justify-center gap-1 rounded-md border text-[10px]" style={{ borderColor: 'rgba(214,168,79,.3)', background: 'rgba(214,168,79,.08)', color: sub }} onClick={openSource} title={`固定参考提交 ${SOURCE_COMMIT}`}>
          <Github size={12} /><span>出处：GuiYi-Xi/monoform-previs-studio</span><Heart size={11} /><strong>感谢原作者</strong>
        </button>
        <div className="flex items-center justify-between gap-2 text-[10px]" style={{ color: d.error ? '#fb7185' : sub }}>
          <span className="truncate" title={d.error || message}>{d.error || message}</span>
          <span className="shrink-0">5 秒 · 24 FPS</span>
        </div>
      </div>

      {editorOpen && createPortal(
        <Suspense fallback={<div className="fixed inset-0 z-[10050] flex items-center justify-center bg-[#181817] text-[#ece9e0]"><Loader2 className="mr-2 animate-spin" />正在加载白模预演工作台…</div>}>
          <LazyPrevisStudioEditor
            ref={editorRef}
            initialProject={project}
            storageKey={`t8-previs-studio-project:${id}`}
            projectTitle={String(d.title || '未命名白模镜头')}
            onProjectChange={writeProject}
            onImportAsset={(file) => uploadFileBlob(file, `previs-model-${id}-${Date.now()}-${file.name}`)}
            onRequestRun={requestRun}
            onReady={onEditorReady}
            onClose={() => { if (!busy) setEditorOpen(false); else setMessage('导出完成后再关闭工作台。'); }}
          />
        </Suspense>,
        document.body,
      )}
    </div>
  );
};

export default memo(PrevisStudioNode);
