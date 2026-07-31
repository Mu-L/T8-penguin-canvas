import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Eye,
  FolderPlus,
  FileText,
  Globe2,
  Image as ImageIcon,
  Library,
  Music,
  PackageOpen,
  Pencil,
  PersonStanding,
  Plus,
  Search,
  Send,
  Star,
  Trash2,
  UserRoundCog,
  Upload,
  Video,
  Workflow,
  X,
} from 'lucide-react';
import type { CSSProperties } from 'react';
import { useThemeStore } from '../stores/theme';
import * as api from '../services/api';
import type { ResourceAddKind, ResourceCategory, ResourceItem, ResourceKind } from '../services/api';
import { isPortraitResourceItem } from '../utils/portraitResource';
import { resourceItemToSendMaterials } from '../utils/sendMaterials';
import { summarizeWorkflowResource } from '../utils/workflowResource';
import LoopingVideo from './LoopingVideo';
import SmartImage from './SmartImage';

const KIND_META: Record<ResourceKind, { label: string; icon: typeof ImageIcon; accent: string }> = {
  image: { label: '图像', icon: ImageIcon, accent: '#fbbf24' },
  video: { label: '视频', icon: Video, accent: '#fb7185' },
  audio: { label: '音频', icon: Music, accent: '#a78bfa' },
  panorama: { label: '全景', icon: Globe2, accent: '#38bdf8' },
  set: { label: '素材集', icon: PackageOpen, accent: '#2dd4bf' },
  pose: { label: '姿势', icon: PersonStanding, accent: '#fb923c' },
  workflow: { label: '工作流', icon: Workflow, accent: '#60a5fa' },
};

const LOCAL_UPLOAD_ACCEPT: Record<ResourceAddKind, string> = {
  image: 'image/png,image/jpeg,image/webp,image/gif,image/bmp,image/avif',
  video: 'video/mp4,video/webm,video/quicktime,video/x-m4v,video/x-matroska,video/x-msvideo',
  audio: 'audio/mpeg,audio/wav,audio/ogg,audio/mp4,audio/flac,audio/aac',
  panorama: 'image/png,image/jpeg,image/webp,image/gif,image/bmp,image/avif',
};

function isLocalUploadKind(kind: ResourceKind): kind is ResourceAddKind {
  return kind === 'image' || kind === 'video' || kind === 'audio' || kind === 'panorama';
}

function localUploadTitle(file: File) {
  const raw = file.name || '本地资产';
  const withoutExt = raw.replace(/\.[^/.]+$/, '').trim();
  return (withoutExt || raw).slice(0, 120);
}

function resourceItemDragKind(item: ResourceItem) {
  return item.kind === 'panorama' ? 'image' : item.kind;
}

interface ResourceLibraryDrawerProps {
  open: boolean;
  onClose: () => void;
  onInsertMaterial: (item: ResourceItem) => void | Promise<void>;
}

function formatSize(size: number) {
  if (!Number.isFinite(size) || size <= 0) return '';
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function materialSetLabel(kind?: string) {
  if (kind === 'image') return '图像集';
  if (kind === 'video') return '视频集';
  if (kind === 'audio') return '音频集';
  if (kind === 'text') return '文本集';
  return '素材集';
}

type WorkflowPreview = NonNullable<ResourceItem['workflowPreview']>;

function workflowNodeColor(type: string) {
  if (type === 'image' || type === 'edit') return '#fbbf24';
  if (type === 'video' || type === 'seedance') return '#fb7185';
  if (type === 'audio') return '#a78bfa';
  if (type === 'llm') return '#86efac';
  if (type === 'output') return '#f97316';
  if (type === 'upload' || type === 'material-set') return '#2dd4bf';
  if (type === 'pose-master' || type === 'portrait-master') return '#38bdf8';
  return '#f8fafc';
}

function workflowNodeShortLabel(type: string, label: string) {
  if (type === 'image') return '图';
  if (type === 'video') return '视';
  if (type === 'seedance') return 'SD';
  if (type === 'audio') return '音';
  if (type === 'llm') return 'AI';
  if (type === 'output') return '出';
  if (type === 'upload') return '入';
  if (type === 'material-set') return '集';
  if (type === 'pose-master') return '姿';
  if (type === 'portrait-master') return '肖';
  return Array.from(label || type || '?').slice(0, 2).join('');
}

function WorkflowTopologyCard({ item, accent }: { item: ResourceItem; accent: string }) {
  const preview = item.workflowPreview as WorkflowPreview | undefined;
  const markerId = `workflow-arrow-${String(item.id).replace(/[^a-zA-Z0-9_-]/g, '-')}`;
  if (!preview?.nodes?.length) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-1.5">
        <Workflow size={32} className="text-white drop-shadow" />
        <div className="rounded-full bg-black/45 px-2 py-0.5 text-[10px] font-semibold text-white">
          {summarizeWorkflowResource(item)}
        </div>
      </div>
    );
  }
  const nodeMap = new Map(preview.nodes.map((node) => [node.id, node]));
  return (
    <div className="relative h-full w-full overflow-hidden">
      <svg viewBox="0 0 100 100" className="absolute inset-0 h-full w-full" role="img" aria-label={`${item.title} 工作流拓扑预览`}>
        <defs>
          <pattern id={`${markerId}-grid`} width="10" height="10" patternUnits="userSpaceOnUse">
            <path d="M 10 0 L 0 0 0 10" fill="none" stroke="rgba(255,255,255,.12)" strokeWidth="0.6" />
          </pattern>
          <marker id={markerId} markerWidth="4" markerHeight="4" refX="3.3" refY="2" orient="auto" markerUnits="strokeWidth">
            <path d="M 0 0 L 4 2 L 0 4 z" fill="rgba(255,255,255,.78)" />
          </marker>
        </defs>
        <rect x="0" y="0" width="100" height="100" fill={`url(#${markerId}-grid)`} opacity="0.8" />
        {preview.edges.map((edge, index) => {
          const source = nodeMap.get(edge.source);
          const target = nodeMap.get(edge.target);
          if (!source || !target) return null;
          const midX = (source.x + target.x) / 2;
          const bend = source.y === target.y ? 0 : (target.y > source.y ? -7 : 7);
          return (
            <path
              key={`${edge.source}-${edge.target}-${index}`}
              d={`M ${source.x} ${source.y} Q ${midX} ${(source.y + target.y) / 2 + bend} ${target.x} ${target.y}`}
              fill="none"
              stroke="rgba(255,255,255,.76)"
              strokeWidth="2.2"
              strokeLinecap="round"
              markerEnd={`url(#${markerId})`}
            />
          );
        })}
        {preview.nodes.map((node) => {
          const color = workflowNodeColor(node.type);
          return (
            <g key={node.id}>
              <circle cx={node.x} cy={node.y} r="8.6" fill="rgba(0,0,0,.44)" stroke="rgba(255,255,255,.72)" strokeWidth="1" />
              <circle cx={node.x} cy={node.y} r="6.8" fill={color} stroke="rgba(0,0,0,.38)" strokeWidth="1" />
              <text x={node.x} y={node.y + 2.4} textAnchor="middle" fontSize="5.4" fontWeight="800" fill="#0f172a">
                {workflowNodeShortLabel(node.type, node.label)}
              </text>
            </g>
          );
        })}
      </svg>
      <div className="absolute left-1.5 top-1.5 rounded-full bg-black/50 px-2 py-0.5 text-[10px] font-semibold text-white shadow">
        拓扑预览
      </div>
      <div className="absolute bottom-1.5 left-1.5 right-1.5 flex items-center justify-between gap-1 rounded-md bg-black/55 px-2 py-1 text-[10px] font-semibold text-white">
        <span className="truncate">{summarizeWorkflowResource(item)}</span>
        <span className="shrink-0 rounded-full px-1.5 py-0.5" style={{ background: accent, color: '#07111f' }}>
          {preview.nodes.length}
        </span>
      </div>
    </div>
  );
}

function resultData<T>(r: api.Result<T> | any): T | null {
  return r?.success ? (r.data as T) : null;
}

function stopResourceControlEvent(event: { stopPropagation: () => void }) {
  event.stopPropagation();
}

type CategoryDialogState =
  | { mode: 'add'; kind: ResourceKind; label: string; value: string }
  | { mode: 'rename'; category: ResourceCategory; label: string; value: string };

type ItemRenameDialogState = { item: ResourceItem; value: string };

export default function ResourceLibraryDrawer({ open, onClose, onInsertMaterial }: ResourceLibraryDrawerProps) {
  const { theme, style } = useThemeStore();
  const isDark = theme === 'dark';
  const isPixel = style === 'pixel';
  const [kind, setKind] = useState<ResourceKind>('image');
  const [categoryId, setCategoryId] = useState('all');
  const [q, setQ] = useState('');
  const [favoriteOnly, setFavoriteOnly] = useState(false);
  const [categories, setCategories] = useState<ResourceCategory[]>([]);
  const [items, setItems] = useState<ResourceItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState('');
  const [hoverPreview, setHoverPreview] = useState<{ src: string; title: string; left: number; top: number } | null>(null);
  const [categoryDialog, setCategoryDialog] = useState<CategoryDialogState | null>(null);
  const [itemRenameDialog, setItemRenameDialog] = useState<ItemRenameDialogState | null>(null);
  const [uploadingLocal, setUploadingLocal] = useState(false);
  const localUploadInputRef = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async () => {
    if (!open) return;
    setLoading(true);
    const [catRes, itemRes] = await Promise.all([
      api.getResourceCategories(kind),
      api.getResourceItems({ kind, categoryId, q, favorite: favoriteOnly }),
    ]);
    const nextCats = resultData<ResourceCategory[]>(catRes);
    const nextItems = resultData<ResourceItem[]>(itemRes);
    const filteredCats = nextCats ? nextCats.filter((cat) => cat.kind === kind) : null;
    const filteredItems = nextItems ? nextItems.filter((item) => item.kind === kind) : null;
    if (filteredCats) setCategories(filteredCats);
    if (filteredItems) setItems(filteredItems);
    if (!nextCats || !nextItems) {
      setMsg((catRes as any)?.error || (itemRes as any)?.error || '资源库加载失败');
    } else if (kind === 'panorama' && nextCats.length > 0 && filteredCats?.length === 0) {
      setMsg('后端尚未加载全景资源类型，请重启开发后端后再打开资源库。');
    }
    setLoading(false);
  }, [open, kind, categoryId, q, favoriteOnly]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!open) return;
    const onChanged = () => load();
    window.addEventListener('penguin:resources-changed', onChanged);
    return () => window.removeEventListener('penguin:resources-changed', onChanged);
  }, [open, load]);

  useEffect(() => {
    setCategoryId('all');
    setFavoriteOnly(false);
    setCategoryDialog(null);
    setItemRenameDialog(null);
  }, [kind]);

  const activeMeta = KIND_META[kind];
  const ActiveIcon = activeMeta.icon;
  const totalText = useMemo(() => `${items.length} 个资源`, [items.length]);
  const localUploadSupported = isLocalUploadKind(kind);
  const localUploadCategory = categoryId !== 'all' ? categories.find((cat) => cat.id === categoryId) : undefined;
  const localUploadCategoryId = localUploadSupported && categoryId !== 'all' ? categoryId : '';
  const localUploadAccept = localUploadSupported ? LOCAL_UPLOAD_ACCEPT[kind] : '';
  const localUploadTargetLabel = localUploadCategory?.name || '当前分类';

  const openAddCategoryDialog = () => {
    setMsg('');
    setCategoryDialog({ mode: 'add', kind, label: activeMeta.label, value: '' });
  };

  const openRenameCategoryDialog = (cat: ResourceCategory) => {
    if (cat.system) return;
    setMsg('');
    setCategoryDialog({ mode: 'rename', category: cat, label: cat.name, value: cat.name });
  };

  const submitCategoryDialog = async () => {
    if (!categoryDialog) return;
    const name = categoryDialog.value.trim();
    if (!name) {
      setMsg('请输入分类名称');
      return;
    }
    if (categoryDialog.mode === 'add') {
      const r = await api.addResourceCategory(categoryDialog.kind, name);
      if (r.success) {
        setMsg(`已创建分类：${name}`);
        setCategoryId(r.data.id);
        setCategoryDialog(null);
        await load();
      } else {
        setMsg(r.error || '分类创建失败');
      }
      return;
    }
    if (name === categoryDialog.category.name) {
      setCategoryDialog(null);
      return;
    }
    const r = await api.renameResourceCategory(categoryDialog.category.id, name);
    if (r.success) {
      setMsg('分类已重命名');
      setCategoryDialog(null);
    } else {
      setMsg(r.error || '分类重命名失败');
    }
    await load();
  };

  const removeCategory = async (cat: ResourceCategory) => {
    if (cat.system) return;
    if (!window.confirm(`删除分类「${cat.name}」？该分类内资源会移动到未分类。`)) return;
    const r = await api.deleteResourceCategory(cat.id);
    setMsg(r.success ? '分类已删除' : r.error || '分类删除失败');
    if (categoryId === cat.id) setCategoryId('all');
    await load();
  };

  const updateItem = async (item: ResourceItem, patch: Parameters<typeof api.updateResourceItem>[1]) => {
    const r = await api.updateResourceItem(item.id, patch);
    if (r.success) {
      setItems((prev) => prev.map((x) => (x.id === item.id ? r.data : x)));
      window.dispatchEvent(new CustomEvent('penguin:resources-changed'));
      return true;
    } else {
      setMsg(r.error || '资源更新失败');
      return false;
    }
  };

  const openItemRenameDialog = (item: ResourceItem) => {
    setMsg('');
    setItemRenameDialog({ item, value: item.title });
  };

  const submitItemRenameDialog = async () => {
    if (!itemRenameDialog) return;
    const title = itemRenameDialog.value.trim();
    if (!title) {
      setMsg('请输入资源名称');
      return;
    }
    if (title === itemRenameDialog.item.title) {
      setItemRenameDialog(null);
      return;
    }
    const ok = await updateItem(itemRenameDialog.item, { title });
    if (ok) setItemRenameDialog(null);
  };

  const handleLocalUploadButtonClick = () => {
    if (!localUploadSupported) {
      setMsg(`${activeMeta.label}暂不支持本地文件直传`);
      return;
    }
    if (!localUploadCategoryId) {
      setMsg('请先选择一个分类再上传本地资产');
      return;
    }
    localUploadInputRef.current?.click();
  };

  const handleLocalUploadFiles = async (fileList: FileList | null) => {
    const files = Array.from(fileList || []);
    if (files.length === 0) return;
    if (!localUploadSupported || !localUploadCategoryId) {
      setMsg('请先选择一个分类再上传本地资产');
      return;
    }
    const uploadKind = kind;
    const uploadTargetName = localUploadTargetLabel;
    setUploadingLocal(true);
    setMsg(`正在上传 ${files.length} 个本地资产到「${uploadTargetName}」...`);
    let saved = 0;
    let duplicates = 0;
    const failures: string[] = [];
    for (const file of files) {
      try {
        const uploaded = await api.uploadResourceLocalFile(file);
        const added = await api.addResourceItem({
          url: uploaded.url,
          kind: uploadKind,
          categoryId: localUploadCategoryId,
          title: localUploadTitle(file),
        });
        if (added.success) {
          saved += 1;
          if (added.data.duplicate) duplicates += 1;
        } else {
          failures.push(`${file.name}: ${added.error || '入库失败'}`);
        }
      } catch (e: any) {
        failures.push(`${file.name}: ${e?.message || '上传失败'}`);
      }
    }
    if (saved > 0) {
      await load();
      window.dispatchEvent(new CustomEvent('penguin:resources-changed'));
    }
    const duplicateText = duplicates > 0 ? `，其中 ${duplicates} 个已存在` : '';
    if (failures.length > 0) {
      setMsg(`已上传 ${saved} 个${duplicateText}，失败 ${failures.length} 个：${failures.slice(0, 2).join('；')}`);
    } else {
      setMsg(`已上传 ${saved} 个本地资产到「${uploadTargetName}」${duplicateText}`);
    }
    setUploadingLocal(false);
  };

  const deleteItem = async (item: ResourceItem) => {
    if (!window.confirm(`从资源库删除「${item.title}」？`)) return;
    const r = await api.deleteResourceItem(item.id);
    if (r.success) {
      setItems((prev) => prev.filter((x) => x.id !== item.id));
      setMsg('资源已删除');
      window.dispatchEvent(new CustomEvent('penguin:resources-changed'));
    } else {
      setMsg(r.error || '资源删除失败');
    }
  };

  const insertItem = async (item: ResourceItem) => {
    try {
      await onInsertMaterial(item);
      await api.updateResourceItem(item.id, { touch: true });
      setMsg(item.kind === 'pose' ? '已恢复为姿势大师节点' : item.kind === 'workflow' ? '已插入工作流' : '已插入画布');
    } catch (e: any) {
      setMsg(e?.message || '插入失败');
    }
  };

  const sendItem = async (item: ResourceItem) => {
    const materials = resourceItemToSendMaterials(item);
    if (materials.length === 0) {
      setMsg('该资源没有可发送素材');
      return;
    }
    window.dispatchEvent(new CustomEvent('penguin:open-send-materials', {
      detail: {
        materials,
        sourceLabel: `资源库 · ${item.title}`,
        defaultMode: item.kind === 'set' ? 'material-set' : 'upload',
      },
    }));
    await api.updateResourceItem(item.id, { touch: true });
  };

  const showImagePreview = useCallback((target: HTMLButtonElement, item: ResourceItem) => {
    const src = item.fileUrl || item.thumbUrl;
    if (!src) return;
    const rect = target.getBoundingClientRect();
    const viewportWidth = window.innerWidth || 1200;
    const viewportHeight = window.innerHeight || 800;
    const previewWidth = Math.min(320, Math.max(240, viewportWidth - 24));
    const previewHeight = 380;
    const gap = 10;
    let left = rect.left - previewWidth - gap;
    if (left < 12) {
      left = Math.min(rect.right + gap, viewportWidth - previewWidth - 12);
    }
    let top = rect.top - 4;
    if (top + previewHeight > viewportHeight - 12) {
      top = Math.max(12, viewportHeight - previewHeight - 12);
    }
    setHoverPreview({
      src,
      title: item.title || '图像预览',
      left,
      top,
    });
  }, []);

  const hideImagePreview = useCallback(() => {
    setHoverPreview(null);
  }, []);

  if (!open) return null;

  const panelCls = isPixel
    ? 'bg-[var(--px-surface)] text-[var(--px-ink)] border-l-2 border-[var(--px-ink)]'
    : isDark
      ? 'bg-zinc-950 text-zinc-100 border-l border-white/10'
      : 'bg-white text-zinc-900 border-l border-black/10';
  const inputCls = isPixel
    ? 'px-input h-9 text-sm'
    : `h-9 px-3 rounded-md border text-sm outline-none ${
        isDark ? 'bg-white/5 border-white/10 text-white placeholder:text-white/30' : 'bg-black/5 border-black/10 text-zinc-900 placeholder:text-zinc-400'
      }`;
  const subtle = isPixel ? 'text-[var(--px-ink-soft)]' : isDark ? 'text-white/45' : 'text-zinc-500';
  const itemBtn = isPixel
    ? 'px-btn px-btn--sm'
    : `px-2 py-1 rounded-md text-xs border ${isDark ? 'border-white/10 hover:bg-white/10' : 'border-black/10 hover:bg-black/5'}`;
  const miniActionBase: CSSProperties = {
    width: 28,
    height: 28,
    minWidth: 28,
    padding: 0,
    borderRadius: 999,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flex: '0 0 28px',
    border: isPixel ? '2px solid var(--px-ink, #1A1410)' : `1px solid ${isDark ? 'rgba(255,255,255,.18)' : 'rgba(0,0,0,.22)'}`,
    background: isPixel ? 'var(--px-surface, #fff)' : isDark ? 'rgba(255,255,255,.06)' : '#fffdf6',
    color: isPixel ? 'var(--px-ink, #1A1410)' : isDark ? '#f8fafc' : '#1f2937',
    boxShadow: isPixel ? '2px 2px 0 var(--px-ink, #1A1410)' : '0 1px 2px rgba(0,0,0,.12)',
    lineHeight: 1,
  };
  const miniInsertStyle: CSSProperties = {
    ...miniActionBase,
    background: isPixel ? 'var(--px-candy-mint, #A8E6C9)' : activeMeta.accent,
    color: isPixel ? 'var(--px-ink, #1A1410)' : '#08111f',
  };
  const miniDeleteStyle: CSSProperties = {
    ...miniActionBase,
    color: isPixel ? '#dc2626' : '#dc2626',
  };

  return (
    <div className={`resource-library-drawer fixed top-0 right-0 z-50 h-screen w-[440px] max-w-[calc(100vw-18px)] shadow-2xl flex flex-col ${panelCls}`}>
      <div className={`h-[52px] px-4 py-3 flex items-center justify-between shrink-0 ${isPixel ? 'border-b-2 border-[var(--px-ink)] bg-[var(--px-muted)]' : isDark ? 'border-b border-white/10' : 'border-b border-black/10'}`}>
        <div className="flex items-center gap-2 min-w-0">
          <Library size={18} style={{ color: activeMeta.accent }} />
          <div className="min-w-0">
            <div className="text-sm font-semibold leading-none">资源库</div>
            <div className={`text-[11px] mt-1 ${subtle}`}>{totalText}</div>
          </div>
        </div>
        <button onClick={onClose} className={isPixel ? 't8-mini-icon-button px-btn px-btn--icon px-btn--ghost' : `t8-mini-icon-button h-9 w-9 p-0 rounded-md ${isDark ? 'hover:bg-white/10' : 'hover:bg-black/5'}`} title="关闭">
          <X size={16} />
        </button>
      </div>

      <div className={`px-3 py-2 flex items-center gap-1.5 shrink-0 ${isPixel ? 'border-b-2 border-[var(--px-ink)]' : isDark ? 'border-b border-white/10' : 'border-b border-black/10'}`}>
        {(Object.keys(KIND_META) as ResourceKind[]).map((k) => {
          const meta = KIND_META[k];
          const Icon = meta.icon;
          const active = kind === k;
          return (
            <button
              key={k}
              onClick={() => setKind(k)}
              className={isPixel ? `px-btn px-btn--sm ${active ? 'px-btn--yellow' : ''}` : `flex-1 h-8 rounded-md text-xs flex items-center justify-center gap-1.5 ${active ? 'text-zinc-950' : subtle}`}
              style={!isPixel && active ? { background: meta.accent } : undefined}
            >
              <Icon size={13} /> {meta.label}
            </button>
          );
        })}
      </div>

      <div className={`px-3 py-2 shrink-0 space-y-2 ${isPixel ? 'border-b-2 border-[var(--px-ink)]' : isDark ? 'border-b border-white/10' : 'border-b border-black/10'}`}>
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search size={14} className={`absolute left-2.5 top-1/2 -translate-y-1/2 ${subtle}`} />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="搜索名称 / 标签"
              className={`${inputCls} w-full pl-8`}
            />
          </div>
          <button
            onClick={() => setFavoriteOnly((v) => !v)}
            className={isPixel ? `resource-library-favorite-filter t8-mini-icon-button px-btn px-btn--icon ${favoriteOnly ? 'px-btn--yellow' : 'px-btn--ghost'}` : `resource-library-favorite-filter t8-mini-icon-button h-9 w-9 p-0 rounded-md border flex items-center justify-center ${favoriteOnly ? 'text-amber-300 border-amber-400/50 bg-amber-400/10' : isDark ? 'border-white/10 hover:bg-white/10' : 'border-black/10 hover:bg-black/5'}`}
            title="收藏"
          >
            <Star size={15} fill={favoriteOnly ? 'currentColor' : 'none'} />
          </button>
          {localUploadSupported && (
            <>
              <input
                ref={localUploadInputRef}
                data-resource-local-upload-input
                type="file"
                className="hidden"
                accept={localUploadAccept}
                multiple
                onChange={(event) => {
                  const input = event.currentTarget;
                  void handleLocalUploadFiles(input.files).finally(() => {
                    input.value = '';
                  });
                }}
              />
              <button
                type="button"
                data-resource-local-upload-button
                onPointerDown={stopResourceControlEvent}
                onMouseDown={stopResourceControlEvent}
                onClick={(event) => {
                  stopResourceControlEvent(event);
                  handleLocalUploadButtonClick();
                }}
                disabled={uploadingLocal}
                className={isPixel
                  ? `nodrag nopan px-btn px-btn--sm flex items-center gap-1 ${localUploadCategoryId ? 'px-btn--yellow' : 'px-btn--ghost opacity-70'}`
                  : `nodrag nopan h-9 shrink-0 rounded-md border px-2 text-xs font-semibold flex items-center gap-1.5 ${localUploadCategoryId ? 'text-zinc-950' : subtle} ${uploadingLocal ? 'opacity-70 cursor-progress' : isDark ? 'border-white/10 hover:bg-white/10' : 'border-black/10 hover:bg-black/5'}`}
                style={!isPixel && localUploadCategoryId ? { background: activeMeta.accent, borderColor: activeMeta.accent } : undefined}
                title={localUploadCategoryId ? `上传到「${localUploadTargetLabel}」` : '先选择一个分类'}
                aria-disabled={!localUploadCategoryId || uploadingLocal}
              >
                <Upload size={14} />
                <span>{uploadingLocal ? '上传中' : '上传'}</span>
              </button>
            </>
          )}
        </div>
      </div>

      <div className="flex-1 min-h-0 flex">
        <aside className={`w-32 shrink-0 overflow-y-auto p-2 space-y-1 ${isPixel ? 'border-r-2 border-[var(--px-ink)] bg-[var(--px-muted)]' : isDark ? 'border-r border-white/10 bg-white/[0.02]' : 'border-r border-black/10 bg-black/[0.02]'}`}>
          <button
            type="button"
            data-resource-category-action="select"
            onPointerDown={stopResourceControlEvent}
            onMouseDown={stopResourceControlEvent}
            onClick={(event) => {
              stopResourceControlEvent(event);
              setCategoryId('all');
            }}
            className={`nodrag nopan w-full text-left px-2 py-1.5 text-xs rounded ${categoryId === 'all' ? (isPixel ? 'bg-[var(--px-yellow)] border-2 border-[var(--px-ink)]' : 'bg-cyan-500/15 text-cyan-300') : ''}`}
          >
            全部
          </button>
          {categories.map((cat) => (
            <div key={cat.id} className="group flex items-center gap-1">
              <button
                type="button"
                data-resource-category-action="select"
                onPointerDown={stopResourceControlEvent}
                onMouseDown={stopResourceControlEvent}
                onClick={(event) => {
                  stopResourceControlEvent(event);
                  setCategoryId(cat.id);
                }}
                className={`nodrag nopan flex-1 min-w-0 text-left px-2 py-1.5 text-xs rounded truncate ${categoryId === cat.id ? (isPixel ? 'bg-[var(--px-yellow)] border-2 border-[var(--px-ink)]' : 'bg-cyan-500/15 text-cyan-300') : isDark ? 'hover:bg-white/10' : 'hover:bg-black/5'}`}
                title={cat.name}
              >
                {cat.name}
              </button>
              {!cat.system && (
                <div className="flex items-center opacity-60 group-hover:opacity-100 group-focus-within:opacity-100">
                  <button
                    type="button"
                    data-resource-category-action="rename"
                    onPointerDown={stopResourceControlEvent}
                    onMouseDown={stopResourceControlEvent}
                    onClick={(event) => {
                      stopResourceControlEvent(event);
                      openRenameCategoryDialog(cat);
                    }}
                    className="nodrag nopan p-1 hover:opacity-100"
                    title="重命名"
                    aria-label={`重命名分类 ${cat.name}`}
                  >
                    <Pencil size={10} />
                  </button>
                  <button
                    type="button"
                    data-resource-category-action="delete"
                    onPointerDown={stopResourceControlEvent}
                    onMouseDown={stopResourceControlEvent}
                    onClick={(event) => {
                      stopResourceControlEvent(event);
                      removeCategory(cat);
                    }}
                    className="nodrag nopan p-1 hover:opacity-100 text-red-400"
                    title="删除"
                    aria-label={`删除分类 ${cat.name}`}
                  >
                    <Trash2 size={10} />
                  </button>
                </div>
              )}
            </div>
          ))}
          <button
            type="button"
            data-resource-category-action="add"
            onPointerDown={stopResourceControlEvent}
            onMouseDown={stopResourceControlEvent}
            onClick={(event) => {
              stopResourceControlEvent(event);
              openAddCategoryDialog();
            }}
            className={`nodrag nopan w-full mt-2 ${itemBtn} flex items-center justify-center gap-1`}
            title="新建分类"
          >
            <FolderPlus size={12} /> 分类
          </button>
        </aside>

        <main className="flex-1 min-w-0 overflow-y-auto p-3">
          {msg && (
            <div className={`mb-2 text-[11px] px-2 py-1 rounded ${isPixel ? 'bg-[var(--px-yellow)] border-2 border-[var(--px-ink)]' : isDark ? 'bg-white/10 text-white/70' : 'bg-black/5 text-zinc-600'}`}>
              {msg}
            </div>
          )}
          {loading && (
            <div className={`text-xs ${subtle}`}>加载中...</div>
          )}
          {!loading && items.length === 0 && (
            <div className={`h-56 flex flex-col items-center justify-center text-xs ${subtle}`}>
              <ActiveIcon size={28} style={{ color: activeMeta.accent }} />
              <span className="mt-2">暂无资源</span>
            </div>
          )}
          <div className="grid grid-cols-2 gap-2">
            {items.map((item) => {
              const isPortraitResource = isPortraitResourceItem(item);
              return (
              <article
                key={item.id}
                className={`resource-card overflow-hidden transition-transform ${isPixel ? 'border-2 border-[var(--px-ink)] bg-[var(--px-surface)] shadow-[3px_3px_0_var(--px-ink)]' : isDark ? 'rounded-lg border border-white/10 bg-white/[0.04]' : 'rounded-lg border border-black/10 bg-black/[0.03]'}`}
                {...(item.kind === 'set' || item.kind === 'pose' || item.kind === 'workflow'
                  ? {}
                  : {
                      'data-drag-source': true,
                      'data-drag-kind': resourceItemDragKind(item),
                      'data-drag-url': item.fileUrl,
                      'data-drag-preview': item.thumbUrl || item.fileUrl,
                      'data-drag-node-id': 'resource-library',
                      'data-drag-name': item.originalName || item.title,
                      'data-drag-mime': item.mime || '',
                      'data-drag-size': String(item.size || 0),
                    })}
                title={
                  isPortraitResource
                    ? '点击恢复为肖像大师节点'
                    : item.kind === 'set'
                    ? '点击插入整个素材集'
                    : item.kind === 'pose'
                      ? '点击恢复为姿势大师节点'
                      : item.kind === 'workflow'
                        ? '点击插入工作流到当前画布'
                        : 'Ctrl+拖拽到节点'
                }
              >
                <div className="relative h-28 overflow-hidden bg-black/80">
                  {(item.kind === 'image' || item.kind === 'panorama') && (
                    <>
                      <SmartImage
                        src={item.thumbUrl || item.fileUrl}
                        alt={item.title}
                        className="resource-media w-full h-full object-cover transition-transform duration-200"
                        draggable={false}
                        thumbSize={320}
                      />
                      <button
                        type="button"
                        className="nodrag nopan t8-mini-icon-button resource-card-preview-trigger"
                        title="悬停预览大图"
                        aria-label="悬停预览大图"
                        onMouseEnter={(event) => showImagePreview(event.currentTarget, item)}
                        onMouseLeave={hideImagePreview}
                        onFocus={(event) => showImagePreview(event.currentTarget, item)}
                        onBlur={hideImagePreview}
                        onMouseDown={(event) => event.stopPropagation()}
                        onClick={(event) => event.stopPropagation()}
                      >
                        <Eye size={13} />
                      </button>
                    </>
                  )}
                  {item.kind === 'video' && (
                    <LoopingVideo
                      src={item.fileUrl}
                      muted
                      className="resource-media w-full h-full object-cover transition-transform duration-200"
                      onMouseEnter={(e) => e.currentTarget.play().catch(() => {})}
                      onMouseLeave={(e) => { e.currentTarget.pause(); e.currentTarget.currentTime = 0; }}
                    />
                  )}
                  {item.kind === 'audio' && (
                    <div className="resource-media w-full h-full flex items-center justify-center transition-transform duration-200" style={{ background: 'linear-gradient(135deg,#312e81,#7c3aed,#db2777)' }}>
                      <Music size={34} className="text-white drop-shadow" />
                    </div>
                  )}
                  {item.kind === 'set' && (
                    <div
                      className="resource-media h-full w-full bg-[var(--t8-bg-panel-muted)] p-2 transition-transform duration-200"
                      style={isPortraitResource ? { background: 'linear-gradient(135deg, rgba(236,72,153,.9), rgba(14,165,233,.78), rgba(15,23,42,.92))' } : undefined}
                    >
                      {isPortraitResource ? (
                        <div className="flex h-full w-full flex-col items-center justify-center gap-1.5 text-center">
                          <UserRoundCog size={36} className="text-white drop-shadow" />
                          <div className="rounded-full bg-black/45 px-2 py-0.5 text-[10px] font-semibold text-white">
                            PortraitMaster
                          </div>
                        </div>
                      ) : (
                        <>
                          <div className="grid h-full grid-cols-2 gap-1 overflow-hidden">
                            {(item.materialSetItems || []).slice(0, 4).map((child, index) => (
                              <div
                                key={child.id || index}
                                className="flex items-center justify-center overflow-hidden rounded border border-black/10 bg-black/10 text-[10px]"
                                title={child.name || child.text || child.url || ''}
                              >
                                {child.kind === 'image' && child.url ? (
                                  <SmartImage src={child.url} className="h-full w-full object-cover" draggable={false} thumbSize={180} />
                                ) : child.kind === 'video' ? (
                                  <Video size={18} className="text-rose-300" />
                                ) : child.kind === 'audio' ? (
                                  <Music size={18} className="text-violet-200" />
                                ) : (
                                  <div className="flex h-full w-full items-center gap-1 p-1 text-left text-[9px] leading-tight text-[var(--t8-text-muted)]">
                                    <FileText size={12} className="shrink-0" />
                                    <span className="line-clamp-3 break-all">{child.text || child.name || '文本'}</span>
                                  </div>
                                )}
                              </div>
                            ))}
                          </div>
                          <div className="absolute bottom-1.5 left-1.5 rounded-full bg-black/60 px-2 py-0.5 text-[10px] font-semibold text-white">
                            {materialSetLabel(item.materialSetKind)} · {item.materialSetItems?.length || 0}
                          </div>
                        </>
                      )}
                    </div>
                  )}
                  {item.kind === 'pose' && (
                    <div
                      className="resource-media flex h-full w-full flex-col items-center justify-center gap-1.5 p-3 text-center transition-transform duration-200"
                      style={{ background: 'linear-gradient(135deg, rgba(251,146,60,.92), rgba(45,212,191,.78), rgba(15,23,42,.92))' }}
                    >
                      <PersonStanding size={36} className="text-white drop-shadow" />
                      <div className="rounded-full bg-black/45 px-2 py-0.5 text-[10px] font-semibold text-white">
                        PoseMaster
                      </div>
                    </div>
                  )}
                  {item.kind === 'workflow' && (
                    <div
                      className="resource-media h-full w-full text-center transition-transform duration-200"
                      style={{ background: 'linear-gradient(135deg, rgba(8,47,73,.95), rgba(14,116,144,.86), rgba(20,184,166,.78))' }}
                    >
                      <WorkflowTopologyCard item={item} accent={activeMeta.accent} />
                    </div>
                  )}
                  <button
                    onClick={() => updateItem(item, { favorite: !item.favorite })}
                    className="t8-mini-icon-button absolute top-1.5 right-1.5 h-7 w-7 rounded-full bg-black/55 text-amber-300 flex items-center justify-center"
                    title="收藏"
                  >
                    <Star size={13} fill={item.favorite ? 'currentColor' : 'none'} />
                  </button>
                </div>
                <div className="p-2 space-y-1.5">
                  <div className="text-xs font-medium truncate" title={item.title}>{item.title}</div>
                  <div className={`text-[10px] truncate ${subtle}`}>
                    {isPortraitResource
                      ? '肖像大师配置 · 可恢复节点'
                      : item.kind === 'set'
                      ? `${materialSetLabel(item.materialSetKind)} · ${item.materialSetItems?.length || 0} 项`
                      : item.kind === 'pose'
                        ? '姿势大师配置 · 可恢复节点'
                        : item.kind === 'workflow'
                          ? `${summarizeWorkflowResource(item)} · 可插入画布`
                          : item.kind === 'panorama'
                            ? `全景贴图 · ${formatSize(item.size) || item.mime || '图像'}`
                      : formatSize(item.size) || item.mime || item.kind}
                  </div>
                  {item.kind === 'audio' && <audio src={item.fileUrl} controls className="w-full h-8" />}
                  <select
                    value={item.categoryId}
                    onChange={(e) => updateItem(item, { categoryId: e.target.value })}
                    className={isPixel ? 'px-input w-full h-7 text-[11px]' : `w-full h-7 px-1.5 rounded text-[11px] ${isDark ? 'bg-zinc-900 border border-white/10' : 'bg-white border border-black/10'}`}
                  >
                    {categories.map((cat) => <option key={cat.id} value={cat.id}>{cat.name}</option>)}
                  </select>
                  <div className="flex items-center justify-center gap-1.5 pt-0.5">
                    <button
                      onClick={() => insertItem(item)}
                      className="nodrag nopan t8-mini-icon-button resource-card-action"
                      style={miniInsertStyle}
                      title={isPortraitResource ? '恢复为肖像大师节点' : '插入画布'}
                      aria-label={isPortraitResource ? '恢复为肖像大师节点' : '插入画布'}
                    >
                      <Plus size={15} />
                    </button>
                    <button
                      onClick={() => sendItem(item)}
                      className="nodrag nopan t8-mini-icon-button resource-card-action"
                      style={miniActionBase}
                      disabled={item.kind === 'workflow'}
                      title={item.kind === 'workflow' ? '工作流可直接插入当前画布' : '发送到画布 / Eagle'}
                      aria-label="发送到画布 / Eagle"
                    >
                      <Send size={13} />
                    </button>
                    <button
                      onClick={() => openItemRenameDialog(item)}
                      className="nodrag nopan t8-mini-icon-button resource-card-action"
                      style={miniActionBase}
                      title="重命名"
                    >
                      <Pencil size={13} />
                    </button>
                    <button
                      onClick={() => deleteItem(item)}
                      className="nodrag nopan t8-mini-icon-button resource-card-action"
                      style={miniDeleteStyle}
                      title="删除"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>
              </article>
              );
            })}
          </div>
        </main>
      </div>
      {categoryDialog && (
        <div
          data-resource-category-dialog="true"
          className="absolute inset-0 z-20 flex items-center justify-center bg-black/45 p-4"
          role="dialog"
          aria-modal="true"
          aria-label={categoryDialog.mode === 'add' ? `新建${categoryDialog.label}分类` : `重命名分类 ${categoryDialog.label}`}
          onPointerDown={stopResourceControlEvent}
          onMouseDown={stopResourceControlEvent}
          onClick={(event) => {
            stopResourceControlEvent(event);
            if (event.currentTarget === event.target) setCategoryDialog(null);
          }}
        >
          <form
            className={isPixel
              ? 'w-full max-w-sm border-2 border-[var(--px-ink)] bg-[var(--px-surface)] p-3 shadow-[4px_4px_0_var(--px-ink)]'
              : `w-full max-w-sm rounded-xl border p-4 shadow-2xl ${isDark ? 'border-white/15 bg-zinc-950 text-white' : 'border-black/10 bg-white text-zinc-950'}`}
            onSubmit={(event) => {
              event.preventDefault();
              void submitCategoryDialog();
            }}
            onPointerDown={stopResourceControlEvent}
            onMouseDown={stopResourceControlEvent}
            onClick={stopResourceControlEvent}
          >
            <div className="mb-3 flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm font-semibold">
                  {categoryDialog.mode === 'add' ? `新建${categoryDialog.label}分类` : '重命名分类'}
                </div>
                <div className={`mt-1 text-[11px] leading-relaxed ${subtle}`}>
                  {categoryDialog.mode === 'add'
                    ? '给当前大分类添加一个新的子分类，方便后续整理资源。'
                    : `当前名称：${categoryDialog.label}`}
                </div>
              </div>
              <button
                type="button"
                className={isPixel ? 't8-mini-icon-button px-btn px-btn--icon px-btn--ghost' : `t8-mini-icon-button h-8 w-8 shrink-0 rounded-md ${isDark ? 'hover:bg-white/10' : 'hover:bg-black/5'}`}
                title="关闭"
                onClick={() => setCategoryDialog(null)}
              >
                <X size={15} />
              </button>
            </div>
            <input
              data-resource-category-dialog-input
              autoFocus
              value={categoryDialog.value}
              onChange={(event) => setCategoryDialog((prev) => (prev ? { ...prev, value: event.target.value } : prev))}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault();
                  setCategoryDialog(null);
                }
              }}
              placeholder="输入分类名称"
              className={`${inputCls} w-full`}
            />
            <div className="mt-4 grid grid-cols-2 gap-2">
              <button
                type="button"
                className={isPixel ? 'px-btn px-btn--ghost' : `h-9 rounded-md border text-sm font-medium ${isDark ? 'border-white/10 hover:bg-white/10' : 'border-black/10 hover:bg-black/5'}`}
                onClick={() => setCategoryDialog(null)}
              >
                取消
              </button>
              <button
                type="submit"
                data-resource-category-dialog-confirm
                className={isPixel ? 'px-btn px-btn--yellow' : 'h-9 rounded-md bg-cyan-400 text-sm font-semibold text-zinc-950 hover:bg-cyan-300'}
              >
                {categoryDialog.mode === 'add' ? '创建' : '保存'}
              </button>
            </div>
          </form>
        </div>
      )}
      {itemRenameDialog && (
        <div
          data-resource-item-rename-dialog="true"
          className="absolute inset-0 z-20 flex items-center justify-center bg-black/45 p-4"
          role="dialog"
          aria-modal="true"
          aria-label={`重命名资源 ${itemRenameDialog.item.title}`}
          onPointerDown={stopResourceControlEvent}
          onMouseDown={stopResourceControlEvent}
          onClick={(event) => {
            stopResourceControlEvent(event);
            if (event.currentTarget === event.target) setItemRenameDialog(null);
          }}
        >
          <form
            className={isPixel
              ? 'w-full max-w-sm border-2 border-[var(--px-ink)] bg-[var(--px-surface)] p-3 shadow-[4px_4px_0_var(--px-ink)]'
              : `w-full max-w-sm rounded-xl border p-4 shadow-2xl ${isDark ? 'border-white/15 bg-zinc-950 text-white' : 'border-black/10 bg-white text-zinc-950'}`}
            onSubmit={(event) => {
              event.preventDefault();
              void submitItemRenameDialog();
            }}
            onPointerDown={stopResourceControlEvent}
            onMouseDown={stopResourceControlEvent}
            onClick={stopResourceControlEvent}
          >
            <div className="mb-3 flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm font-semibold">重命名资源</div>
                <div className={`mt-1 truncate text-[11px] leading-relaxed ${subtle}`} title={itemRenameDialog.item.title}>
                  当前名称：{itemRenameDialog.item.title}
                </div>
              </div>
              <button
                type="button"
                className={isPixel ? 't8-mini-icon-button px-btn px-btn--icon px-btn--ghost' : `t8-mini-icon-button h-8 w-8 shrink-0 rounded-md ${isDark ? 'hover:bg-white/10' : 'hover:bg-black/5'}`}
                title="关闭"
                onClick={() => setItemRenameDialog(null)}
              >
                <X size={15} />
              </button>
            </div>
            <input
              data-resource-item-rename-dialog-input
              autoFocus
              value={itemRenameDialog.value}
              onChange={(event) => setItemRenameDialog((prev) => (prev ? { ...prev, value: event.target.value } : prev))}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault();
                  setItemRenameDialog(null);
                }
              }}
              placeholder="输入资源名称"
              className={`${inputCls} w-full`}
            />
            <div className="mt-4 grid grid-cols-2 gap-2">
              <button
                type="button"
                className={isPixel ? 'px-btn px-btn--ghost' : `h-9 rounded-md border text-sm font-medium ${isDark ? 'border-white/10 hover:bg-white/10' : 'border-black/10 hover:bg-black/5'}`}
                onClick={() => setItemRenameDialog(null)}
              >
                取消
              </button>
              <button
                type="submit"
                data-resource-item-rename-dialog-confirm
                className={isPixel ? 'px-btn px-btn--yellow' : 'h-9 rounded-md bg-cyan-400 text-sm font-semibold text-zinc-950 hover:bg-cyan-300'}
              >
                保存
              </button>
            </div>
          </form>
        </div>
      )}
      {hoverPreview && (
        <div
          className="resource-card-image-hover-preview"
          style={{ left: hoverPreview.left, top: hoverPreview.top }}
          role="presentation"
        >
          <img src={hoverPreview.src} alt={hoverPreview.title} draggable={false} />
          <div className="resource-card-image-hover-preview__title">{hoverPreview.title}</div>
        </div>
      )}
    </div>
  );
}
