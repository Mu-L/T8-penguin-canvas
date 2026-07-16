import { useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Camera, Check, ChevronDown, Download, Eye, FileImage, Focus, Grid3X3,
  ImagePlus, Info, Layers3, Library, Lightbulb, Loader2, Maximize2, RefreshCw, Save,
  ScanFace, Search, ShieldCheck, Shuffle, Sparkles, Trash2, Upload, X,
} from 'lucide-react';
import FaceExpressionViewport, { type FaceExpressionViewportHandle } from './FaceExpressionViewport';
import {
  FACE_CAMERA_PRESETS,
  FACE_CHANNEL_GROUPS,
  FACE_CHANNEL_LABELS,
  FACE_EXPRESSION_PRESETS,
  FACE_LIGHTING_PRESETS,
  applyFaceCameraPreset,
  applyFaceLightingPreset,
  applyFacePreset,
  buildFaceBatchPlan,
  emptyFaceChannels,
  normalizeFaceExpressionState,
  outputSizeForPreset,
  randomizeFaceExpression,
  setFaceChannel,
  type FaceChannel,
  type FaceExpression3DState,
  type FaceExpressionPreset,
  type FaceExpressionTab,
} from '../../utils/faceExpression3D';
import {
  FACE_EXPRESSION_LIBRARY_PRESETS,
  FACE_PRESET_LIBRARY_CATEGORIES,
  type FacePresetLibraryCategory,
} from '../../utils/faceExpressionPresetLibrary';
import type { FaceModelCompatibilityReport } from '../../three/faceExpression/FaceExpressionScene';

interface FaceExpression3DEditorProps {
  state: FaceExpression3DState;
  busy?: boolean;
  batchProgress?: { completed: number; total: number } | null;
  photoBusy?: boolean;
  photoMessage?: string;
  onChange: (state: FaceExpression3DState) => void;
  onAnalyzePhoto: (file: File) => Promise<void> | void;
  onExport: (viewport: FaceExpressionViewportHandle) => Promise<void> | void;
  onBatchExport: (viewport: FaceExpressionViewportHandle) => Promise<void> | void;
  onStop?: () => void;
  onClose: () => void;
}

const TABS: Array<{ id: FaceExpressionTab; label: string; icon: typeof Sparkles }> = [
  { id: 'expression', label: '表情', icon: Sparkles },
  { id: 'presets', label: '表情预设', icon: Library },
  { id: 'pose', label: '头眼', icon: Eye },
  { id: 'camera', label: '相机', icon: Camera },
  { id: 'lighting', label: '灯光', icon: Lightbulb },
  { id: 'output', label: '输出', icon: FileImage },
  { id: 'batch', label: '批量', icon: Layers3 },
];

const SIMPLE_CHANNELS = [
  'mouthSmileLeft', 'mouthFrownLeft', 'mouthPucker', 'jawOpen', 'eyeBlinkLeft',
  'eyeWideLeft', 'eyeSquintLeft', 'browInnerUp', 'browDownLeft', 'cheekPuff',
] as const satisfies readonly FaceChannel[];

const SIMPLE_CHANNEL_LABELS: Record<(typeof SIMPLE_CHANNELS)[number], string> = {
  mouthSmileLeft: '微笑',
  mouthFrownLeft: '嘴角下压',
  mouthPucker: '嘟嘴',
  jawOpen: '张口',
  eyeBlinkLeft: '眨眼',
  eyeWideLeft: '眼睛睁大',
  eyeSquintLeft: '眯眼',
  browInnerUp: '眉心上扬',
  browDownLeft: '眉毛下压',
  cheekPuff: '鼓腮',
};

const fieldClass = 'nodrag h-9 w-full rounded-md border border-white/15 bg-[#151d28] px-2.5 text-[12px] text-slate-100 outline-none focus:border-cyan-400';
const buttonClass = 'nodrag inline-flex h-9 items-center justify-center gap-1.5 rounded-md border border-white/15 bg-[#192433] px-3 text-[12px] font-semibold text-slate-100 transition hover:border-cyan-400/70 hover:bg-[#203044] disabled:cursor-not-allowed disabled:opacity-45';

function stateWith(state: FaceExpression3DState, patch: Partial<FaceExpression3DState>): FaceExpression3DState {
  return normalizeFaceExpressionState({ ...state, ...patch });
}

function SliderRow({ label, value, min = 0, max = 1, step = 0.01, onChange }: {
  label: string; value: number; min?: number; max?: number; step?: number; onChange: (value: number) => void;
}) {
  return (
    <label className="grid grid-cols-[108px_minmax(80px,1fr)_58px] items-center gap-2 py-1 text-[11px] text-slate-300">
      <span className="truncate" title={label}>{label}</span>
      <input className="nodrag accent-cyan-400" type="range" min={min} max={max} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} />
      <input className="nodrag h-7 rounded border border-white/10 bg-[#101720] px-1 text-right text-[11px] text-slate-100" type="number" min={min} max={max} step={step} value={Number(value.toFixed(step < 1 ? 2 : 0))} onChange={(event) => onChange(Number(event.target.value))} />
    </label>
  );
}

function Pill({ active, children, onClick, title }: { active: boolean; children: React.ReactNode; onClick: () => void; title?: string }) {
  return <button type="button" title={title} onClick={onClick} className={`${buttonClass} h-8 px-2.5 ${active ? '!border-cyan-400 !bg-cyan-400/15 !text-cyan-100' : ''}`}>{children}</button>;
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('文件读取失败'));
    reader.readAsDataURL(file);
  });
}

export default function FaceExpression3DEditor({
  state,
  busy = false,
  batchProgress,
  photoBusy = false,
  photoMessage = '',
  onChange,
  onAnalyzePhoto,
  onExport,
  onBatchExport,
  onStop,
  onClose,
}: FaceExpression3DEditorProps) {
  const viewportRef = useRef<FaceExpressionViewportHandle | null>(null);
  const photoInputRef = useRef<HTMLInputElement | null>(null);
  const backgroundInputRef = useRef<HTMLInputElement | null>(null);
  const presetImportRef = useRef<HTMLInputElement | null>(null);
  const [tab, setTab] = useState<FaceExpressionTab>('expression');
  const [advanced, setAdvanced] = useState(false);
  const [presetLibraryCategory, setPresetLibraryCategory] = useState<'all' | FacePresetLibraryCategory>('all');
  const [presetLibraryQuery, setPresetLibraryQuery] = useState('');
  const [presetName, setPresetName] = useState('');
  const [compatibility, setCompatibility] = useState<FaceModelCompatibilityReport | null>(null);
  const [message, setMessage] = useState('');
  const [neutralPreview, setNeutralPreview] = useState(false);
  const [modelInfoOpen, setModelInfoOpen] = useState(false);
  const presets = useMemo(() => [...FACE_EXPRESSION_PRESETS, ...state.customPresets], [state.customPresets]);
  const filteredLibraryPresets = useMemo(() => {
    const query = presetLibraryQuery.trim().toLowerCase();
    return FACE_EXPRESSION_LIBRARY_PRESETS.filter((preset) => {
      if (presetLibraryCategory !== 'all' && preset.category !== presetLibraryCategory) return false;
      if (!query) return true;
      return [preset.name, preset.description, preset.categoryLabel, preset.intensityLabel, ...preset.actionUnits]
        .some((value) => value.toLowerCase().includes(query));
    });
  }, [presetLibraryCategory, presetLibraryQuery]);
  const batchPlan = useMemo(() => buildFaceBatchPlan(state), [state]);
  const viewportState = useMemo(() => neutralPreview ? normalizeFaceExpressionState({
    ...state,
    expression: { ...state.expression, presetId: 'neutral-preview', channels: emptyFaceChannels() },
  }) : state, [neutralPreview, state]);

  const apply = (next: FaceExpression3DState) => onChange(normalizeFaceExpressionState(next));
  const setExpressionValue = (channel: FaceChannel, value: number) => apply(setFaceChannel(state, channel, value));

  const savePreset = () => {
    const name = presetName.trim();
    if (!name) {
      setMessage('请先填写预设名称');
      return;
    }
    const preset: FaceExpressionPreset = {
      id: `custom-${Date.now().toString(36)}`,
      name: name.slice(0, 48),
      channels: { ...state.expression.channels },
    };
    apply({ ...state, customPresets: [...state.customPresets, preset], expression: { ...state.expression, presetId: preset.id } });
    setPresetName('');
    setMessage(`已保存预设“${preset.name}”`);
  };

  const deleteCurrentPreset = () => {
    if (!state.expression.presetId.startsWith('custom-')) return;
    apply({ ...state, customPresets: state.customPresets.filter((item) => item.id !== state.expression.presetId), expression: { ...state.expression, presetId: 'custom' } });
  };

  const exportPresets = () => {
    const blob = new Blob([JSON.stringify({ schema: 't8-face-expression-presets', version: 1, presets: state.customPresets }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 't8-face-expression-presets.json';
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const importPresets = async (file: File) => {
    try {
      const parsed = JSON.parse(await file.text());
      const next = normalizeFaceExpressionState({ ...state, customPresets: [...state.customPresets, ...(Array.isArray(parsed?.presets) ? parsed.presets : [])] });
      apply(next);
      setMessage(`已导入 ${next.customPresets.length - state.customPresets.length} 个预设`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '预设文件格式不正确');
    }
  };

  const renderExpression = () => (
    <div className="space-y-4">
      <section>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-[12px] font-bold text-white">表情预设</h3>
          <div className="flex gap-1">
            <Pill active={!advanced} onClick={() => setAdvanced(false)}>常用</Pill>
            <Pill active={advanced} onClick={() => setAdvanced(true)}>专业 52</Pill>
          </div>
        </div>
        <div className="grid grid-cols-3 gap-1.5">
          {presets.map((preset) => (
            <Pill key={preset.id} active={state.expression.presetId === preset.id} onClick={() => apply(applyFacePreset(state, preset.id))}>{preset.name}</Pill>
          ))}
        </div>
        <div className="mt-2 grid grid-cols-2 gap-2">
          <label className="flex items-center gap-2 rounded-md border border-white/10 bg-[#151d28] px-2 text-[11px] text-slate-300">
            <input type="checkbox" checked={state.expression.symmetryLocked} onChange={(event) => apply({ ...state, expression: { ...state.expression, symmetryLocked: event.target.checked } })} /> 左右联动
          </label>
          <select className={fieldClass} value={state.expression.mode} onChange={(event) => apply({ ...state, expression: { ...state.expression, mode: event.target.value === 'add' ? 'add' : 'replace' } })}>
            <option value="replace">替换预设</option><option value="add">叠加预设</option>
          </select>
        </div>
        <SliderRow label="整体强度" value={state.expression.strength} onChange={(value) => apply({ ...state, expression: { ...state.expression, strength: value } })} />
        <div className="mt-2 grid grid-cols-3 gap-2">
          <button className={`${buttonClass} flex-1`} onClick={() => apply(randomizeFaceExpression(state))}><Shuffle size={14} />随机表情</button>
          <button
            className={`${buttonClass} flex-1 ${neutralPreview ? '!border-amber-300 !bg-amber-300/15 !text-amber-100' : ''}`}
            onPointerDown={() => setNeutralPreview(true)}
            onPointerUp={() => setNeutralPreview(false)}
            onPointerCancel={() => setNeutralPreview(false)}
            onPointerLeave={() => setNeutralPreview(false)}
            title="按住临时查看中性基线，松开恢复当前表情"
          ><Eye size={14} />中性对照</button>
          <button className={`${buttonClass} flex-1`} onClick={() => apply({ ...state, expression: { ...state.expression, presetId: 'neutral', channels: emptyFaceChannels() } })}><RefreshCw size={14} />归零</button>
        </div>
      </section>

      <section className="border-t border-white/10 pt-3">
        {advanced ? FACE_CHANNEL_GROUPS.map((group) => (
          <details className="mb-2 rounded-md border border-white/10 bg-[#111923]" key={group.id} open={group.id === 'mouth' || group.id === 'eyes'}>
            <summary className="nodrag flex cursor-pointer items-center justify-between px-3 py-2 text-[12px] font-bold text-slate-100">{group.label}<ChevronDown size={13} /></summary>
            <div className="border-t border-white/10 px-3 py-2">{group.channels.map((channel) => <SliderRow key={channel} label={FACE_CHANNEL_LABELS[channel]} value={state.expression.channels[channel]} onChange={(value) => setExpressionValue(channel, value)} />)}</div>
          </details>
        )) : SIMPLE_CHANNELS.map((channel) => <SliderRow key={channel} label={SIMPLE_CHANNEL_LABELS[channel]} value={state.expression.channels[channel]} onChange={(value) => setExpressionValue(channel, value)} />)}
      </section>

      <section className="border-t border-white/10 pt-3">
        <h3 className="mb-2 text-[12px] font-bold text-white">自定义预设</h3>
        <div className="flex gap-2"><input className={fieldClass} value={presetName} onChange={(event) => setPresetName(event.target.value)} placeholder="给当前表情命名" /><button className={buttonClass} onClick={savePreset}><Save size={14} />保存</button></div>
        <div className="mt-2 grid grid-cols-3 gap-2">
          <button className={buttonClass} onClick={() => presetImportRef.current?.click()}><Upload size={13} />导入</button>
          <button className={buttonClass} onClick={exportPresets} disabled={!state.customPresets.length}><Download size={13} />导出</button>
          <button className={buttonClass} onClick={deleteCurrentPreset} disabled={!state.expression.presetId.startsWith('custom-')}><Trash2 size={13} />删除</button>
        </div>
      </section>
    </div>
  );

  const renderPresetLibrary = () => (
    <div className="space-y-3" data-testid="face-expression-preset-library">
      <section className="sticky top-0 z-[2] space-y-2 border-b border-white/10 bg-[#0f1721] pb-3">
        <div className="flex items-center justify-between">
          <div><h3 className="text-[12px] font-black text-white">表情预设</h3><span className="text-[10px] text-slate-400">FACS / ARKit 52 通道</span></div>
          <span className="rounded border border-cyan-300/25 bg-cyan-300/10 px-2 py-1 text-[10px] font-bold text-cyan-100">{filteredLibraryPresets.length}/100</span>
        </div>
        <label className="relative block">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500" size={14} />
          <input className={`${fieldClass} pl-8`} value={presetLibraryQuery} onChange={(event) => setPresetLibraryQuery(event.target.value)} placeholder="搜索表情或动作单元" />
        </label>
        <div className="grid grid-cols-2 gap-1.5">
          {FACE_PRESET_LIBRARY_CATEGORIES.map((category) => (
            <Pill key={category.id} active={presetLibraryCategory === category.id} onClick={() => setPresetLibraryCategory(category.id)}>{category.label}</Pill>
          ))}
        </div>
        <select className={fieldClass} value={state.expression.mode} onChange={(event) => apply({ ...state, expression: { ...state.expression, mode: event.target.value === 'add' ? 'add' : 'replace' } })}>
          <option value="replace">替换当前表情</option><option value="add">叠加到当前表情</option>
        </select>
      </section>
      <section className="grid grid-cols-2 gap-2">
        {filteredLibraryPresets.map((preset) => {
          const active = state.expression.presetId === preset.id;
          return <button
            key={preset.id}
            type="button"
            className={`nodrag min-h-[66px] rounded-md border p-2 text-left transition ${active ? 'border-cyan-300 bg-cyan-300/15 shadow-[inset_0_0_0_1px_rgba(103,232,249,.2)]' : 'border-white/10 bg-[#151d28] hover:border-cyan-300/55 hover:bg-[#1b2938]'}`}
            onClick={() => apply(applyFacePreset(state, preset.id))}
            title={`${preset.description} · ${preset.actionUnits.join(' + ')}`}
            data-preset-id={preset.id}
          >
            <span className={`block truncate text-[11px] font-black ${active ? 'text-cyan-100' : 'text-slate-100'}`}>{preset.name}</span>
            <span className="mt-1 block truncate text-[9px] text-slate-400">{preset.categoryLabel} · {preset.actionUnits.join('+')}</span>
            <span className="mt-1 block truncate text-[9px] text-slate-500">{preset.description}</span>
          </button>;
        })}
      </section>
    </div>
  );

  const renderPose = () => (
    <div className="space-y-4">
      <section><h3 className="mb-2 text-[12px] font-bold text-white">头部朝向</h3>
        <SliderRow label="上下点头" value={state.pose.head.pitch} min={-50} max={50} step={1} onChange={(value) => apply({ ...state, pose: { ...state.pose, head: { ...state.pose.head, pitch: value } } })} />
        <SliderRow label="左右转头" value={state.pose.head.yaw} min={-75} max={75} step={1} onChange={(value) => apply({ ...state, pose: { ...state.pose, head: { ...state.pose.head, yaw: value } } })} />
        <SliderRow label="侧倾" value={state.pose.head.roll} min={-45} max={45} step={1} onChange={(value) => apply({ ...state, pose: { ...state.pose, head: { ...state.pose.head, roll: value } } })} />
        <SliderRow label="颈部跟随" value={state.pose.head.neckFollow} onChange={(value) => apply({ ...state, pose: { ...state.pose, head: { ...state.pose.head, neckFollow: value } } })} />
      </section>
      <section className="border-t border-white/10 pt-3"><h3 className="mb-2 text-[12px] font-bold text-white">视线</h3>
        <select className={fieldClass} value={state.pose.eyes.mode} onChange={(event) => apply({ ...state, pose: { ...state.pose, eyes: { ...state.pose.eyes, mode: event.target.value as 'manual' | 'camera' | 'target' } } })}>
          <option value="camera">看相机</option><option value="manual">手动</option><option value="target">看目标点</option>
        </select>
        {state.pose.eyes.mode === 'manual' && <div className="mt-2"><SliderRow label="左右" value={state.pose.eyes.left[0]} min={-1} max={1} onChange={(value) => apply({ ...state, pose: { ...state.pose, eyes: { ...state.pose.eyes, left: [value, state.pose.eyes.left[1]], right: [value, state.pose.eyes.right[1]] } } })} /><SliderRow label="上下" value={state.pose.eyes.left[1]} min={-1} max={1} onChange={(value) => apply({ ...state, pose: { ...state.pose, eyes: { ...state.pose.eyes, left: [state.pose.eyes.left[0], value], right: [state.pose.eyes.right[0], value] } } })} /></div>}
      </section>
      <section className="border-t border-white/10 pt-3"><h3 className="mb-2 text-[12px] font-bold text-white">模型外观</h3>
        <div className="grid grid-cols-3 gap-2">
          {([['skinColor', '肤色'], ['hairColor', '发色'], ['irisColor', '虹膜']] as const).map(([key, label]) => <label key={key} className="rounded-md border border-white/10 bg-[#151d28] p-2 text-[10px] text-slate-300"><span>{label}</span><input className="mt-1 h-8 w-full" type="color" value={state.model[key]} onChange={(event) => apply({ ...state, model: { ...state.model, [key]: event.target.value } })} /></label>)}
        </div>
      </section>
    </div>
  );

  const renderCamera = () => (
    <div className="space-y-4"><section><h3 className="mb-2 text-[12px] font-bold text-white">构图预设</h3><div className="grid grid-cols-2 gap-2">{FACE_CAMERA_PRESETS.map((preset) => <Pill key={preset.id} active={state.camera.framingPreset === preset.id} onClick={() => apply(applyFaceCameraPreset(state, preset.id))}>{preset.name}</Pill>)}</div></section>
      <section className="border-t border-white/10 pt-3"><select className={fieldClass} value={state.camera.projection} onChange={(event) => apply({ ...state, camera: { ...state.camera, projection: event.target.value === 'orthographic' ? 'orthographic' : 'perspective', framingPreset: 'custom' } })}><option value="perspective">透视相机</option><option value="orthographic">正交相机</option></select><SliderRow label="视野 FOV" value={state.camera.fov} min={18} max={75} step={1} onChange={(value) => apply({ ...state, camera: { ...state.camera, fov: value, framingPreset: 'custom' } })} /><label className="mt-2 flex items-center gap-2 rounded-md border border-white/10 bg-[#151d28] px-3 py-2 text-[11px] text-slate-300"><input type="checkbox" checked={state.camera.guides} onChange={(event) => apply({ ...state, camera: { ...state.camera, guides: event.target.checked } })} /><Grid3X3 size={14} />九宫格构图线</label></section>
      <div className="rounded-md border border-cyan-400/25 bg-cyan-400/10 p-3 text-[11px] leading-relaxed text-cyan-100">可直接在中间预览区拖动旋转、滚轮缩放，结束操作后会保存相机位置。</div>
    </div>
  );

  const renderLighting = () => (
    <div className="space-y-4"><section><h3 className="mb-2 text-[12px] font-bold text-white">布光预设</h3><div className="grid grid-cols-2 gap-2">{Object.entries(FACE_LIGHTING_PRESETS).map(([id, preset]) => <Pill key={id} active={state.lighting.presetId === id} onClick={() => apply(applyFaceLightingPreset(state, id))}>{preset.name}</Pill>)}</div><SliderRow label="曝光" value={state.lighting.exposure} min={0.25} max={2.5} onChange={(value) => apply({ ...state, lighting: { ...state.lighting, exposure: value, presetId: 'custom' } })} /></section>
      {state.lighting.lights.map((light, index) => <details key={light.id} className="rounded-md border border-white/10 bg-[#111923]" open={light.id === 'key'}><summary className="cursor-pointer px-3 py-2 text-[12px] font-bold text-slate-100">{({ ambient: '环境光', key: '主光', fill: '补光', rim: '轮廓光' } as const)[light.id]}</summary><div className="border-t border-white/10 p-3"><label className="mb-2 flex items-center gap-2 text-[11px] text-slate-300">颜色 <input type="color" value={light.color} onChange={(event) => { const lights = state.lighting.lights.map((item, itemIndex) => itemIndex === index ? { ...item, color: event.target.value } : item); apply({ ...state, lighting: { ...state.lighting, lights, presetId: 'custom' } }); }} /></label><SliderRow label="强度" value={light.intensity} min={0} max={8} onChange={(value) => { const lights = state.lighting.lights.map((item, itemIndex) => itemIndex === index ? { ...item, intensity: value } : item); apply({ ...state, lighting: { ...state.lighting, lights, presetId: 'custom' } }); }} />{light.id !== 'ambient' && <><SliderRow label="方位" value={light.azimuth} min={-180} max={180} step={1} onChange={(value) => { const lights = state.lighting.lights.map((item, itemIndex) => itemIndex === index ? { ...item, azimuth: value } : item); apply({ ...state, lighting: { ...state.lighting, lights, presetId: 'custom' } }); }} /><SliderRow label="高度" value={light.elevation} min={-90} max={90} step={1} onChange={(value) => { const lights = state.lighting.lights.map((item, itemIndex) => itemIndex === index ? { ...item, elevation: value } : item); apply({ ...state, lighting: { ...state.lighting, lights, presetId: 'custom' } }); }} /></>}</div></details>)}
    </div>
  );

  const setBackgroundFile = async (file: File) => {
    try { const value = await readAsDataUrl(file); apply({ ...state, output: { ...state.output, transparent: false, background: { ...state.output.background, kind: 'image', value } } }); } catch (error) { setMessage(error instanceof Error ? error.message : '背景读取失败'); }
  };

  const renderOutput = () => (
    <div className="space-y-4"><section><h3 className="mb-2 text-[12px] font-bold text-white">图片规格</h3><div className="grid grid-cols-3 gap-2">{['1:1-1K', '1:1-2K', '1:1-4K', '3:4', '4:3', '9:16', '16:9'].map((id) => <Pill key={id} active={state.output.width === outputSizeForPreset(id, state.output).width && state.output.height === outputSizeForPreset(id, state.output).height} onClick={() => apply({ ...state, output: outputSizeForPreset(id, state.output) })}>{id.replace('-1K', ' 1K').replace('-2K', ' 2K').replace('-4K', ' 4K')}</Pill>)}</div><div className="mt-2 grid grid-cols-2 gap-2"><input className={fieldClass} type="number" min={256} max={4096} value={state.output.width} onChange={(event) => apply({ ...state, output: { ...state.output, width: Number(event.target.value), ratioId: 'custom' } })} /><input className={fieldClass} type="number" min={256} max={4096} value={state.output.height} onChange={(event) => apply({ ...state, output: { ...state.output, height: Number(event.target.value), ratioId: 'custom' } })} /></div></section>
      <section className="border-t border-white/10 pt-3"><h3 className="mb-2 text-[12px] font-bold text-white">格式与背景</h3><select className={fieldClass} value={state.output.format} onChange={(event) => { const format = event.target.value as 'png' | 'jpeg' | 'webp'; apply({ ...state, output: { ...state.output, format, transparent: format === 'jpeg' ? false : state.output.transparent } }); }}><option value="png">PNG</option><option value="jpeg">JPEG</option><option value="webp">WebP</option></select><div className="mt-2 grid grid-cols-3 gap-2"><Pill active={state.output.background.kind === 'color'} onClick={() => apply({ ...state, output: { ...state.output, transparent: false, background: { ...state.output.background, kind: 'color', value: state.output.background.value.startsWith('#') ? state.output.background.value : '#E7EDF2' } } })}>纯色</Pill><Pill active={state.output.background.kind === 'image'} onClick={() => backgroundInputRef.current?.click()}><ImagePlus size={13} />图片</Pill><Pill active={state.output.transparent} onClick={() => apply({ ...state, output: { ...state.output, format: state.output.format === 'jpeg' ? 'png' : state.output.format, transparent: true, background: { ...state.output.background, kind: 'transparent' } } })}>透明</Pill></div>{state.output.background.kind === 'color' && <input className="mt-2 h-9 w-full" type="color" value={state.output.background.value} onChange={(event) => apply({ ...state, output: { ...state.output, background: { ...state.output.background, value: event.target.value } } })} />}{state.output.background.kind === 'image' && <><select className={`${fieldClass} mt-2`} value={state.output.background.fit} onChange={(event) => apply({ ...state, output: { ...state.output, background: { ...state.output.background, fit: event.target.value === 'contain' ? 'contain' : 'cover' } } })}><option value="cover">铺满裁切</option><option value="contain">完整显示</option></select><SliderRow label="背景模糊" value={state.output.background.blur} min={0} max={24} step={1} onChange={(value) => apply({ ...state, output: { ...state.output, background: { ...state.output.background, blur: value } } })} /></>}</section>
      <div className="rounded-md border border-emerald-400/25 bg-emerald-400/10 p-3 text-[11px] leading-relaxed text-emerald-100">导出使用独立渲染器按目标像素重绘，不会把预览区截图放大。支持透明 PNG/WebP 和最高 4096 × 4096。</div>
    </div>
  );

  const toggleBatchValue = (key: 'expressionPresetIds' | 'cameraPresetIds', value: string) => {
    const source = state.batch[key];
    const next = source.includes(value) ? source.filter((item) => item !== value) : [...source, value];
    apply({ ...state, batch: { ...state.batch, [key]: next } });
  };

  const renderBatch = () => (
    <div className="space-y-4"><section><h3 className="mb-2 text-[12px] font-bold text-white">组合方式</h3><div className="grid grid-cols-2 gap-2"><Pill active={state.batch.mode === 'pair'} onClick={() => apply({ ...state, batch: { ...state.batch, mode: 'pair' } })}>顺序配对</Pill><Pill active={state.batch.mode === 'cartesian'} onClick={() => apply({ ...state, batch: { ...state.batch, mode: 'cartesian' } })}>全部组合</Pill></div></section>
      <section className="border-t border-white/10 pt-3"><h3 className="mb-2 text-[12px] font-bold text-white">表情</h3><div className="grid grid-cols-2 gap-2">{presets.map((preset) => <Pill key={preset.id} active={state.batch.expressionPresetIds.includes(preset.id)} onClick={() => toggleBatchValue('expressionPresetIds', preset.id)}>{preset.name}</Pill>)}</div></section>
      <section className="border-t border-white/10 pt-3"><h3 className="mb-2 text-[12px] font-bold text-white">相机</h3><div className="grid grid-cols-2 gap-2">{FACE_CAMERA_PRESETS.map((preset) => <Pill key={preset.id} active={state.batch.cameraPresetIds.includes(preset.id)} onClick={() => toggleBatchValue('cameraPresetIds', preset.id)}>{preset.name}</Pill>)}</div></section>
      <section className="rounded-md border border-white/10 bg-[#151d28] p-3"><div className="flex items-center justify-between text-[12px] font-bold text-white"><span>预计输出</span><strong className="text-cyan-300">{batchPlan.length} 张</strong></div><SliderRow label="最大数量" value={state.batch.maxItems} min={1} max={64} step={1} onChange={(value) => apply({ ...state, batch: { ...state.batch, maxItems: value } })} />{batchProgress && <div className="mt-2"><div className="mb-1 flex justify-between text-[10px] text-slate-300"><span>正在渲染</span><span>{batchProgress.completed}/{batchProgress.total}</span></div><div className="h-2 overflow-hidden rounded bg-black/40"><div className="h-full bg-cyan-400" style={{ width: `${batchProgress.total ? batchProgress.completed / batchProgress.total * 100 : 0}%` }} /></div></div>}</section>
    </div>
  );

  const panel = tab === 'expression' ? renderExpression() : tab === 'presets' ? renderPresetLibrary() : tab === 'pose' ? renderPose() : tab === 'camera' ? renderCamera() : tab === 'lighting' ? renderLighting() : tab === 'output' ? renderOutput() : renderBatch();

  return createPortal(
    <div className="fixed inset-0 z-[10040] flex bg-black/75 p-3 backdrop-blur-sm" onMouseDown={(event) => event.stopPropagation()} data-testid="face-expression-editor">
      <div className="mx-auto flex h-full w-full max-w-[1720px] min-w-0 flex-col overflow-hidden rounded-lg border border-cyan-300/30 bg-[#0c121a] text-slate-100 shadow-2xl">
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-white/10 bg-[#111a25] px-4">
          <div className="flex h-9 w-9 items-center justify-center rounded-md bg-cyan-400 text-[#071018]"><ScanFace size={20} /></div>
          <div className="min-w-0 flex-1"><h2 className="truncate text-[16px] font-black">3D 表情编辑器</h2><p className="truncate text-[10px] text-slate-400">52 表情通道 · 照片比例校准 · 灯光相机 · 批量图片输出</p></div>
          {compatibility && <button type="button" className="nodrag hidden h-9 items-center gap-2 rounded-md border border-emerald-300/25 bg-emerald-300/10 px-3 text-[10px] font-bold text-emerald-100 lg:inline-flex" onClick={() => setModelInfoOpen(true)} title="查看模型兼容性、来源和许可证"><ShieldCheck size={14} />{compatibility.source === 'builtin' ? `ICT 中性人类白模 · ${compatibility.mappedChannels.length}/52 通道` : `自定义模型 · ${compatibility.mappedChannels.length}/${compatibility.morphTargetCount} 映射`}</button>}
          <button type="button" className={`${buttonClass} h-9 w-9 px-0`} onClick={onClose} title="关闭编辑器"><X size={17} /></button>
        </header>

        <div className="grid min-h-0 flex-1 grid-cols-[72px_minmax(360px,1fr)_390px] max-[900px]:grid-cols-[60px_minmax(280px,1fr)]">
          <nav className="flex min-h-0 flex-col gap-1 border-r border-white/10 bg-[#0f1721] p-2">
            {TABS.map(({ id, label, icon: Icon }) => <button key={id} type="button" className={`nodrag flex h-14 flex-col items-center justify-center gap-1 rounded-md text-[10px] font-bold transition ${tab === id ? 'bg-cyan-400 text-[#071018]' : 'text-slate-400 hover:bg-white/5 hover:text-white'}`} onClick={() => setTab(id)} title={label}><Icon size={17} /><span>{label}</span></button>)}
          </nav>

          <main className="relative min-h-0 min-w-0 bg-[#1d2935]">
            <FaceExpressionViewport ref={viewportRef} state={viewportState} className="h-full w-full" onStateChange={neutralPreview ? undefined : apply} onCompatibility={setCompatibility} onError={setMessage} />
            {neutralPreview && <div className="pointer-events-none absolute left-1/2 top-4 z-[5] -translate-x-1/2 rounded-md border border-amber-200/40 bg-amber-200/90 px-3 py-1.5 text-[11px] font-black text-[#352b12] shadow-lg">中性基线预览 · 松开恢复</div>}
            <div className="absolute bottom-4 left-4 right-4 z-[4] grid grid-cols-[minmax(0,1fr)_auto] gap-2 rounded-md border border-white/15 bg-black/65 p-2 backdrop-blur-md">
              <button type="button" className={`${buttonClass} h-10 justify-start overflow-hidden`} onClick={() => photoInputRef.current?.click()} disabled={photoBusy}><ScanFace size={16} /> <span className="truncate">{photoBusy ? '正在分析脸部...' : state.model.photoCalibration ? `已校准 · 置信度 ${Math.round(state.model.photoCalibration.confidence * 100)}%` : '上传人物脸部图片进行比例校准'}</span></button>
              <button type="button" className={`${buttonClass} h-10 px-4`} onClick={() => apply({ ...state, camera: { ...state.camera, guides: !state.camera.guides } })} title="构图线"><Focus size={16} /></button>
              {(photoMessage || message) && <div className="col-span-2 truncate px-1 text-[10px] text-cyan-100" title={photoMessage || message}>{photoMessage || message}</div>}
            </div>
          </main>

          <aside className="min-h-0 overflow-y-auto border-l border-white/10 bg-[#0f1721] p-4 max-[900px]:col-span-2 max-[900px]:max-h-[43vh] max-[900px]:border-l-0 max-[900px]:border-t">
            {panel}
          </aside>
        </div>

        <footer className="flex min-h-14 shrink-0 items-center gap-2 border-t border-white/10 bg-[#111a25] px-4 py-2">
          <div className="mr-auto hidden text-[10px] text-slate-400 sm:block">照片功能只校准可测量的脸部比例、颜色与当前表情，不承诺身份级 3D 重建。</div>
          {busy && onStop && <button className={`${buttonClass} !border-rose-400/60 !text-rose-200`} onClick={onStop}><X size={14} />停止</button>}
          <button className={buttonClass} disabled={busy} onClick={() => viewportRef.current && void onBatchExport(viewportRef.current)}><Layers3 size={15} />批量导出 {batchPlan.length}</button>
          <button className={`${buttonClass} !border-cyan-300 !bg-cyan-400 !text-[#071018]`} disabled={busy} onClick={() => viewportRef.current && void onExport(viewportRef.current)}>{busy ? <Loader2 size={15} className="animate-spin" /> : <Maximize2 size={15} />}生成图片</button>
        </footer>
      </div>

      <input ref={photoInputRef} className="hidden" type="file" accept="image/*" onChange={(event) => { const file = event.target.files?.[0]; event.currentTarget.value = ''; if (file) void onAnalyzePhoto(file); }} />
      <input ref={backgroundInputRef} className="hidden" type="file" accept="image/*" onChange={(event) => { const file = event.target.files?.[0]; event.currentTarget.value = ''; if (file) void setBackgroundFile(file); }} />
      <input ref={presetImportRef} className="hidden" type="file" accept="application/json,.json" onChange={(event) => { const file = event.target.files?.[0]; event.currentTarget.value = ''; if (file) void importPresets(file); }} />
      {modelInfoOpen && <div className="absolute inset-0 z-[20] flex items-center justify-center bg-black/65 p-6" onMouseDown={() => setModelInfoOpen(false)}>
        <section className="w-full max-w-[620px] rounded-lg border border-cyan-300/30 bg-[#111a25] p-5 shadow-2xl" onMouseDown={(event) => event.stopPropagation()} aria-label="3D模型信息">
          <div className="mb-4 flex items-start gap-3"><div className="flex h-10 w-10 items-center justify-center rounded-md bg-emerald-300 text-[#071018]"><ShieldCheck size={21} /></div><div className="min-w-0 flex-1"><h3 className="text-[16px] font-black text-white">模型体检与来源</h3><p className="mt-0.5 text-[11px] text-slate-400">默认资产必须通过表情通道、离线可用和许可证检查。</p></div><button type="button" className={`${buttonClass} h-9 w-9 px-0`} onClick={() => setModelInfoOpen(false)} title="关闭模型信息"><X size={16} /></button></div>
          <div className="grid grid-cols-2 gap-2 text-[11px]">
            <div className="rounded-md border border-emerald-300/20 bg-emerald-300/10 p-3"><strong className="block text-emerald-100">表情通道</strong><span className="mt-1 block text-slate-300">{compatibility?.mappedChannels.length || 0}/52 已映射</span></div>
            <div className="rounded-md border border-emerald-300/20 bg-emerald-300/10 p-3"><strong className="block text-emerald-100">姿态控制</strong><span className="mt-1 block text-slate-300">头部、颈部、左右视线</span></div>
            <div className="rounded-md border border-white/10 bg-white/5 p-3"><strong className="block text-white">资产版本</strong><span className="mt-1 block text-slate-300">t8-ict-neutral-head-v1</span></div>
            <div className="rounded-md border border-white/10 bg-white/5 p-3"><strong className="block text-white">本地资源</strong><span className="mt-1 block text-slate-300">18.71 MB · Electron 离线可用</span></div>
          </div>
          <div className="mt-3 rounded-md border border-white/10 bg-[#0d141d] p-3 text-[11px] leading-relaxed text-slate-300"><div className="mb-1 flex items-center gap-2 font-bold text-white"><Info size={14} />模型来源</div>基于 USC Institute for Creative Technologies 的 ICT Face Model Light 制作，MIT License。T8 将中性拓扑和表达形变转换为单个 GLB，并映射至现有52通道。</div>
          {compatibility?.warnings.length ? <div className="mt-3 rounded-md border border-amber-300/25 bg-amber-300/10 p-3 text-[11px] text-amber-100">{compatibility.warnings.join('；')}</div> : <div className="mt-3 flex items-center gap-2 rounded-md border border-emerald-300/25 bg-emerald-300/10 p-3 text-[11px] font-bold text-emerald-100"><Check size={14} />模型体检通过，没有缺失的表情通道</div>}
          <a className={`${buttonClass} mt-4 w-full`} href="https://github.com/USC-ICT/ICT-FaceKit" target="_blank" rel="noreferrer"><Info size={14} />查看 ICT FaceKit 来源</a>
        </section>
      </div>}
    </div>,
    document.body,
  );
}
