import { memo, useCallback, useMemo, useState, type UIEvent } from 'react';
import * as Icons from 'lucide-react';
import {
  Check,
  ChevronDown,
  ChevronRight,
  Edit2,
  FolderOpen,
  Loader2,
  Plus,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import { NODE_GROUPS } from '../config/nodeRegistry';

// vite.config.ts 中通过 define 注入的编译期常量（与 package.json version 同步）
declare const __APP_VERSION__: string;
import type { CanvasListItem, NodeMeta, NodeType } from '../types/canvas';
import { useThemeStore } from '../stores/theme';
import { useCanvasStore } from '../stores/canvas';
import { listCanvasPage } from '../services/api';
import { resolveThemeTemplate } from '../theme/defaultTemplates';
const COLOR_HEX: Record<string, string> = {
  sky: '#7dd3fc',
  amber: '#fcd34d',
  rose: '#fda4af',
  fuchsia: '#f0abfc',
  violet: '#c4b5fd',
  emerald: '#6ee7b7',
  cyan: '#67e8f9',
  indigo: '#a5b4fc',
  orange: '#fdba74',
  pink: '#f9a8d4',
  teal: '#5eead4',
  slate: '#cbd5e1',
};

const OP_ICON_BY_TYPE: Record<string, string> = {
  upload: 'Anchor',
  output: 'Gem',
  text: 'ScrollText',
  image: 'Map',
  video: 'Telescope',
  seedance: 'Film',
  audio: 'Music2',
  llm: 'Compass',
  runninghub: 'Waypoints',
  'runninghub-wallet': 'WalletCards',
  'rh-tools': 'ShipWheel',
  'rh-toolbox': 'Wrench',
  'grok-oauth-agent': 'Bot',
  'codex-cli-agent': 'TerminalSquare',
  'codex-image-conjure': 'ImagePlus',
  'artist-style-master': 'Palette',
  'anime-tag-master': 'Tags',
  'frame-pair': 'Telescope',
  loop: 'Repeat',
  'pick-from-set': 'Map',
  resize: 'Maximize2',
  combine: 'Boxes',
  'grid-crop': 'Grid3x3',
  'grid-editor': 'LayoutGrid',
  idea: 'Lightbulb',
  bp: 'Map',
  relay: 'ArrowRightLeft',
  cinematic: 'Clapperboard',
  'video-motion': 'Sailboat',
  'pose-master': 'PersonStanding',
  'panorama-3d': 'Globe2',
};

const NARUTO_ICON_BY_TYPE: Record<string, string> = {
  upload: 'BadgeUp',
  output: 'BadgeCheck',
  text: 'ScrollText',
  image: 'Flame',
  video: 'Zap',
  seedance: 'Film',
  audio: 'Drum',
  llm: 'BrainCircuit',
  runninghub: 'Network',
  'runninghub-wallet': 'BadgeDollarSign',
  'rh-tools': 'Boxes',
  'rh-toolbox': 'Wrench',
  'grok-oauth-agent': 'Bot',
  'codex-cli-agent': 'TerminalSquare',
  'codex-image-conjure': 'ImagePlus',
  'artist-style-master': 'Palette',
  'anime-tag-master': 'Tags',
  'frame-pair': 'ScanEye',
  loop: 'Repeat2',
  'pick-from-set': 'PackageOpen',
  resize: 'MoveDiagonal',
  combine: 'Layers3',
  'grid-crop': 'Grid3x3',
  'grid-editor': 'LayoutGrid',
  idea: 'Lightbulb',
  bp: 'BookOpen',
  relay: 'ArrowRightLeft',
  cinematic: 'Clapperboard',
  'video-motion': 'Route',
  'multi-angle-visual': 'Orbit',
  'text-split': 'Scissors',
  'image-compare': 'ScanSearch',
  'material-set': 'Package',
  'pose-master': 'PersonStanding',
  'panorama-3d': 'Globe2',
};

const EVA_ICON_BY_TYPE: Record<string, string> = {
  upload: 'FileUp',
  output: 'MonitorCheck',
  text: 'Terminal',
  image: 'ScanLine',
  video: 'Clapperboard',
  seedance: 'Film',
  audio: 'Radio',
  llm: 'BrainCircuit',
  runninghub: 'Network',
  'runninghub-wallet': 'KeyRound',
  'rh-tools': 'Boxes',
  'rh-toolbox': 'Wrench',
  'grok-oauth-agent': 'Bot',
  'codex-cli-agent': 'TerminalSquare',
  'codex-image-conjure': 'ImagePlus',
  'artist-style-master': 'Palette',
  'anime-tag-master': 'Tags',
  'frame-pair': 'ScanEye',
  loop: 'Repeat2',
  'pick-from-set': 'PackageOpen',
  resize: 'MoveDiagonal',
  combine: 'Layers3',
  'grid-crop': 'Grid3x3',
  'grid-editor': 'LayoutGrid',
  idea: 'Lightbulb',
  bp: 'BookOpen',
  relay: 'Cable',
  cinematic: 'Clapperboard',
  'video-motion': 'Route',
  'multi-angle-visual': 'Orbit',
  'text-split': 'Scissors',
  'image-compare': 'ScanSearch',
  'material-set': 'Package',
  'pose-master': 'PersonStanding',
  'panorama-3d': 'Globe2',
};

const YYH_ICON_BY_TYPE: Record<string, string> = {
  upload: 'FileUp',
  output: 'MonitorCheck',
  text: 'ScrollText',
  image: 'Sparkles',
  video: 'Clapperboard',
  seedance: 'Film',
  audio: 'Radio',
  llm: 'BrainCircuit',
  runninghub: 'Network',
  'runninghub-wallet': 'KeyRound',
  'rh-tools': 'Boxes',
  'rh-toolbox': 'Wrench',
  'grok-oauth-agent': 'Bot',
  'codex-cli-agent': 'TerminalSquare',
  'codex-image-conjure': 'ImagePlus',
  'artist-style-master': 'Palette',
  'anime-tag-master': 'Tags',
  'frame-pair': 'ScanEye',
  loop: 'Repeat2',
  'pick-from-set': 'PackageOpen',
  resize: 'MoveDiagonal',
  combine: 'Layers3',
  'grid-crop': 'Grid3x3',
  'grid-editor': 'LayoutGrid',
  idea: 'Lightbulb',
  bp: 'BookOpen',
  relay: 'Cable',
  cinematic: 'Clapperboard',
  'video-motion': 'Route',
  'multi-angle-visual': 'Orbit',
  'text-split': 'Scissors',
  'image-compare': 'ScanSearch',
  'material-set': 'Package',
  'drawing-board': 'PenTool',
  'portrait-master': 'UserRoundCog',
  'pose-master': 'PersonStanding',
  'panorama-3d': 'Globe2',
};

const SLAMDUNK_ICON_BY_TYPE: Record<string, string> = {
  upload: 'FileUp',
  output: 'Trophy',
  text: 'ClipboardList',
  image: 'Image',
  video: 'Clapperboard',
  seedance: 'Film',
  audio: 'Radio',
  llm: 'BrainCircuit',
  runninghub: 'Network',
  'runninghub-wallet': 'BadgeDollarSign',
  'rh-tools': 'Boxes',
  'rh-toolbox': 'Wrench',
  'grok-oauth-agent': 'Bot',
  'codex-cli-agent': 'TerminalSquare',
  'codex-image-conjure': 'ImagePlus',
  'artist-style-master': 'Palette',
  'anime-tag-master': 'Tags',
  'frame-pair': 'ScanEye',
  loop: 'Repeat2',
  'pick-from-set': 'PackageOpen',
  resize: 'MoveDiagonal',
  combine: 'Layers3',
  'grid-crop': 'Grid3x3',
  'grid-editor': 'LayoutGrid',
  idea: 'Lightbulb',
  bp: 'NotebookTabs',
  relay: 'ArrowRightLeft',
  cinematic: 'Clapperboard',
  'video-motion': 'Route',
  'multi-angle-visual': 'Orbit',
  'text-split': 'Scissors',
  'image-compare': 'ScanSearch',
  'material-set': 'Package',
  'drawing-board': 'PenTool',
  'portrait-master': 'UserRoundCog',
  'pose-master': 'PersonStanding',
  'panorama-3d': 'Globe2',
};

const SOCCER_ICON_BY_TYPE: Record<string, string> = {
  upload: 'FileUp',
  output: 'Trophy',
  text: 'ClipboardList',
  image: 'Image',
  video: 'Clapperboard',
  seedance: 'Film',
  audio: 'Radio',
  llm: 'BrainCircuit',
  runninghub: 'Network',
  'runninghub-wallet': 'BadgeDollarSign',
  'rh-tools': 'Boxes',
  'rh-toolbox': 'Wrench',
  'grok-oauth-agent': 'Bot',
  'codex-cli-agent': 'TerminalSquare',
  'codex-image-conjure': 'ImagePlus',
  'artist-style-master': 'Palette',
  'anime-tag-master': 'Tags',
  'frame-pair': 'ScanEye',
  loop: 'Repeat2',
  'pick-from-set': 'PackageOpen',
  resize: 'MoveDiagonal',
  combine: 'Layers3',
  'grid-crop': 'Grid3x3',
  'grid-editor': 'LayoutGrid',
  idea: 'Lightbulb',
  bp: 'NotebookTabs',
  relay: 'ArrowRightLeft',
  cinematic: 'Clapperboard',
  'video-motion': 'Route',
  'multi-angle-visual': 'Orbit',
  'text-split': 'Scissors',
  'image-compare': 'ScanSearch',
  'material-set': 'Package',
  'drawing-board': 'PenTool',
  'portrait-master': 'UserRoundCog',
  'pose-master': 'PersonStanding',
  'panorama-3d': 'Globe2',
};

const DRAGON_BALL_ICON_BY_TYPE: Record<string, string> = {
  upload: 'PackagePlus',
  output: 'Sparkles',
  text: 'ScrollText',
  image: 'Sun',
  video: 'Clapperboard',
  seedance: 'Film',
  audio: 'Radio',
  llm: 'BrainCircuit',
  runninghub: 'Network',
  'runninghub-wallet': 'BadgeDollarSign',
  'rh-tools': 'Boxes',
  'rh-toolbox': 'Wrench',
  'grok-oauth-agent': 'Bot',
  'codex-cli-agent': 'TerminalSquare',
  'codex-image-conjure': 'ImagePlus',
  'artist-style-master': 'Palette',
  'anime-tag-master': 'Tags',
  'frame-pair': 'ScanEye',
  loop: 'Repeat2',
  'pick-from-set': 'PackageOpen',
  resize: 'MoveDiagonal',
  combine: 'Layers3',
  'grid-crop': 'Grid3x3',
  'grid-editor': 'LayoutGrid',
  idea: 'Lightbulb',
  bp: 'NotebookTabs',
  relay: 'ArrowRightLeft',
  cinematic: 'Clapperboard',
  'video-motion': 'Route',
  'multi-angle-visual': 'Orbit',
  'text-split': 'Scissors',
  'image-compare': 'ScanSearch',
  'material-set': 'Package',
  'drawing-board': 'PenTool',
  'portrait-master': 'UserRoundCog',
  'pose-master': 'PersonStanding',
  'panorama-3d': 'Radar',
};

const SAINT_SEIYA_ICON_BY_TYPE: Record<string, string> = {
  upload: 'Shield',
  output: 'Crown',
  text: 'ScrollText',
  image: 'Sparkles',
  video: 'Clapperboard',
  seedance: 'Film',
  audio: 'Radio',
  llm: 'BrainCircuit',
  runninghub: 'Network',
  'runninghub-wallet': 'BadgeDollarSign',
  'rh-tools': 'Boxes',
  'rh-toolbox': 'Wrench',
  'grok-oauth-agent': 'Bot',
  'codex-cli-agent': 'TerminalSquare',
  'codex-image-conjure': 'ImagePlus',
  'artist-style-master': 'Palette',
  'anime-tag-master': 'Tags',
  'frame-pair': 'ScanEye',
  loop: 'Repeat2',
  'pick-from-set': 'PackageOpen',
  resize: 'MoveDiagonal',
  combine: 'Layers3',
  'grid-crop': 'Grid3x3',
  'grid-editor': 'LayoutGrid',
  idea: 'Lightbulb',
  bp: 'NotebookTabs',
  relay: 'ArrowRightLeft',
  cinematic: 'Clapperboard',
  'video-motion': 'Route',
  'multi-angle-visual': 'Orbit',
  'text-split': 'Scissors',
  'image-compare': 'ScanSearch',
  'material-set': 'Archive',
  'drawing-board': 'PenTool',
  'portrait-master': 'UserRoundCog',
  'pose-master': 'PersonStanding',
  'panorama-3d': 'Globe2',
};

const FARM_STORY_ICON_BY_TYPE: Record<string, string> = {
  upload: 'PackagePlus',
  output: 'Wheat',
  text: 'NotebookText',
  image: 'Flower2',
  video: 'Clapperboard',
  seedance: 'Film',
  audio: 'Music2',
  llm: 'BrainCircuit',
  runninghub: 'Network',
  'runninghub-wallet': 'BadgeDollarSign',
  'rh-tools': 'Hammer',
  'rh-toolbox': 'Wrench',
  'grok-oauth-agent': 'Bot',
  'codex-cli-agent': 'TerminalSquare',
  'codex-image-conjure': 'ImagePlus',
  'artist-style-master': 'Palette',
  'anime-tag-master': 'Tags',
  'frame-pair': 'ScanEye',
  loop: 'Repeat2',
  'pick-from-set': 'PackageOpen',
  resize: 'MoveDiagonal',
  combine: 'Layers3',
  'grid-crop': 'Grid3x3',
  'grid-editor': 'LayoutGrid',
  idea: 'Lightbulb',
  bp: 'NotebookTabs',
  relay: 'ArrowRightLeft',
  cinematic: 'Clapperboard',
  'video-motion': 'Route',
  'multi-angle-visual': 'Orbit',
  'text-split': 'Scissors',
  'image-compare': 'ScanSearch',
  'material-set': 'Package',
  'drawing-board': 'PenTool',
  'portrait-master': 'UserRoundCog',
  'pose-master': 'PersonStanding',
  'panorama-3d': 'Globe2',
};

interface SidebarProps {
  onAddNode: (type: NodeType) => void;
}

const CANVAS_ROW_HEIGHT = 42;
const CANVAS_VIEWPORT_HEIGHT = 224;
const CANVAS_ROW_OVERSCAN = 4;

interface CanvasCatalogRowProps {
  canvas: CanvasListItem;
  isActive: boolean;
  isEditing: boolean;
  needsDeleteConfirm: boolean;
  hasCompletionNotice: boolean;
  editingName: string;
  isDark: boolean;
  isPixel: boolean;
  onSelect: (id: string) => void;
  onEditingNameChange: (name: string) => void;
  onStartEdit: (id: string, name: string) => void;
  onSubmitEdit: () => void;
  onCancelEdit: () => void;
  onRequestDelete: (id: string) => void;
  onConfirmDelete: (id: string) => void;
  onCancelDelete: () => void;
}

const CanvasCatalogRow = memo(function CanvasCatalogRow({
  canvas,
  isActive,
  isEditing,
  needsDeleteConfirm,
  hasCompletionNotice,
  editingName,
  isDark,
  isPixel,
  onSelect,
  onEditingNameChange,
  onStartEdit,
  onSubmitEdit,
  onCancelEdit,
  onRequestDelete,
  onConfirmDelete,
  onCancelDelete,
}: CanvasCatalogRowProps) {
  return (
    <div
      onClick={() => !isEditing && onSelect(canvas.id)}
      data-canvas-completion-notice={hasCompletionNotice ? 'true' : undefined}
      className={`t8-sidebar-canvas-row group h-full px-2 py-1 cursor-pointer text-[11px] transition-colors ${
        isPixel
          ? `px-row ${isActive ? 'is-active' : ''}`
          : `rounded-md ${
              isActive
                ? isDark
                  ? 'bg-white/10 text-white'
                  : 'bg-black/10 text-zinc-900'
                : isDark
                  ? 'text-white/70 hover:bg-white/5'
                  : 'text-zinc-700 hover:bg-black/5'
            }`
      }`}
    >
      {isEditing ? (
        <input
          autoFocus
          value={editingName}
          onChange={(event) => onEditingNameChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') onSubmitEdit();
            if (event.key === 'Escape') onCancelEdit();
          }}
          onBlur={onSubmitEdit}
          className={`w-full px-1.5 py-0.5 rounded text-[11px] outline-none border ${
            isDark ? 'bg-zinc-800 border-white/20 text-white' : 'bg-white border-black/20'
          }`}
        />
      ) : (
        <div className="flex items-center gap-1.5">
          <div className="flex-1 min-w-0">
            <div className="t8-sidebar-canvas-title flex min-w-0 items-center gap-1">
              <span className="truncate font-medium">{canvas.name}</span>
              {hasCompletionNotice && (
                <span
                  className="t8-sidebar-canvas-update-dot"
                  role="img"
                  aria-label="这个画布有新生成完成，切换后自动清除"
                  title="这个画布有新生成完成，切换后自动清除"
                />
              )}
            </div>
            <div className={`text-[10px] ${isDark ? 'text-white/30' : 'text-zinc-400'}`}>
              {canvas.nodeCount} 个节点
            </div>
          </div>
          <div className="opacity-0 group-hover:opacity-100 flex items-center gap-0.5 transition-opacity">
            {needsDeleteConfirm ? (
              <>
                <button
                  onClick={(event) => {
                    event.stopPropagation();
                    onConfirmDelete(canvas.id);
                  }}
                  className="p-0.5 rounded hover:bg-red-500/20 text-red-400"
                  title="确认删除"
                >
                  <Check size={11} />
                </button>
                <button
                  onClick={(event) => {
                    event.stopPropagation();
                    onCancelDelete();
                  }}
                  className={`p-0.5 rounded ${isDark ? 'hover:bg-white/10' : 'hover:bg-black/10'}`}
                  title="取消删除"
                >
                  <X size={11} />
                </button>
              </>
            ) : (
              <>
                <button
                  onClick={(event) => {
                    event.stopPropagation();
                    onStartEdit(canvas.id, canvas.name);
                  }}
                  className={`p-0.5 rounded ${isDark ? 'hover:bg-white/10' : 'hover:bg-black/10'}`}
                  title="重命名"
                >
                  <Edit2 size={10} />
                </button>
                <button
                  onClick={(event) => {
                    event.stopPropagation();
                    onRequestDelete(canvas.id);
                  }}
                  className={`p-0.5 rounded ${
                    isDark ? 'hover:bg-red-500/20 text-red-400' : 'hover:bg-red-100 text-red-600'
                  }`}
                  title="删除"
                >
                  <Trash2 size={10} />
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
});

export default function Sidebar({ onAddNode }: SidebarProps) {
  const { theme, style, templateId, customTemplates } = useThemeStore();
  const currentTemplate = useMemo(
    () => resolveThemeTemplate(templateId, customTemplates),
    [templateId, customTemplates],
  );
  const visualStyle = currentTemplate.visuals?.style || style;
  const isDark = theme === 'dark';
  const isPixel = style === 'pixel';
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [keyword, setKeyword] = useState('');

  // 画布管理(整合到节点侧边栏顶部)
  const canvases = useCanvasStore((state) => state.canvases);
  const activeId = useCanvasStore((state) => state.activeId);
  const canvasLoading = useCanvasStore((state) => state.loading);
  const canvasLoadingMore = useCanvasStore((state) => state.loadingMore);
  const canvasTotal = useCanvasStore((state) => state.total);
  const canvasHasMore = useCanvasStore((state) => state.hasMore);
  const canvasCatalogPartial = useCanvasStore((state) => state.catalogPartial);
  const canvasRecovery = useCanvasStore((state) => state.recovery);
  const completionNoticeCanvasIds = useCanvasStore((state) => state.completionNoticeCanvasIds);
  const loadMoreCanvases = useCanvasStore((state) => state.loadMoreCanvases);
  const createCanvas = useCanvasStore((state) => state.createCanvas);
  const deleteCanvas = useCanvasStore((state) => state.deleteCanvas);
  const renameCanvas = useCanvasStore((state) => state.renameCanvas);
  const setActive = useCanvasStore((state) => state.setActive);
  const [canvasPanelOpen, setCanvasPanelOpen] = useState(true);
  const [canvasScrollTop, setCanvasScrollTop] = useState(0);
  const [canvasSearchDraft, setCanvasSearchDraft] = useState('');
  const [canvasSearchQuery, setCanvasSearchQuery] = useState('');
  const [canvasSearchLoading, setCanvasSearchLoading] = useState(false);
  const [canvasSearchResults, setCanvasSearchResults] = useState<CanvasListItem[]>([]);
  const [canvasSearchCursor, setCanvasSearchCursor] = useState<string | null>(null);
  const [canvasSearchHasMore, setCanvasSearchHasMore] = useState(false);
  const [canvasSearchUnavailable, setCanvasSearchUnavailable] = useState(false);
  const [canvasSearchError, setCanvasSearchError] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const completionNoticeSet = useMemo(() => new Set(completionNoticeCanvasIds), [completionNoticeCanvasIds]);
  const displayedCanvasTotal = canvasTotal ?? canvases.length;
  const displayedCanvases = canvasSearchQuery ? canvasSearchResults : canvases;
  const canvasVisibleRange = useMemo(() => {
    const first = Math.max(0, Math.floor(canvasScrollTop / CANVAS_ROW_HEIGHT) - CANVAS_ROW_OVERSCAN);
    const count = Math.ceil(CANVAS_VIEWPORT_HEIGHT / CANVAS_ROW_HEIGHT) + CANVAS_ROW_OVERSCAN * 2;
    return { start: first, end: Math.min(displayedCanvases.length, first + count) };
  }, [canvasScrollTop, displayedCanvases.length]);
  const visibleCanvases = useMemo(
    () => displayedCanvases.slice(canvasVisibleRange.start, canvasVisibleRange.end),
    [displayedCanvases, canvasVisibleRange],
  );

  const handleCreateCanvas = useCallback(async () => {
    const name = `画布 ${displayedCanvasTotal + 1}`;
    await createCanvas(name);
  }, [createCanvas, displayedCanvasTotal]);

  const startEdit = useCallback((id: string, name: string) => {
    setEditingId(id);
    setEditingName(name);
  }, []);

  const submitEdit = useCallback(async () => {
    if (editingId && editingName.trim()) {
      await renameCanvas(editingId, editingName.trim());
    }
    setEditingId(null);
  }, [editingId, editingName, renameCanvas]);

  const handleDeleteCanvas = useCallback(async (id: string) => {
    await deleteCanvas(id);
    setConfirmDelete(null);
  }, [deleteCanvas]);

  const handleCanvasListScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    const element = event.currentTarget;
    setCanvasScrollTop(element.scrollTop);
    if (!canvasSearchQuery
      && element.scrollHeight - element.scrollTop - element.clientHeight < CANVAS_ROW_HEIGHT * 3) {
      void loadMoreCanvases();
    }
  }, [canvasSearchQuery, loadMoreCanvases]);

  const handleCanvasSearch = useCallback(async () => {
    const query = canvasSearchDraft.trim();
    setCanvasScrollTop(0);
    if (!query) {
      setCanvasSearchQuery('');
      setCanvasSearchResults([]);
      setCanvasSearchCursor(null);
      setCanvasSearchHasMore(false);
      setCanvasSearchUnavailable(false);
      setCanvasSearchError('');
      return;
    }
    setCanvasSearchLoading(true);
    setCanvasSearchError('');
    try {
      const page = await listCanvasPage({ limit: 50, query });
      setCanvasSearchQuery(query);
      setCanvasSearchResults(page.items);
      setCanvasSearchCursor(page.nextCursor);
      setCanvasSearchHasMore(page.hasMore);
      setCanvasSearchUnavailable(page.searchUnavailable);
    } catch (error: any) {
      setCanvasSearchQuery(query);
      setCanvasSearchResults([]);
      setCanvasSearchCursor(null);
      setCanvasSearchHasMore(false);
      setCanvasSearchError(error?.message || '搜索画布失败');
    } finally {
      setCanvasSearchLoading(false);
    }
  }, [canvasSearchDraft]);

  const handleLoadMoreCanvasSearch = useCallback(async () => {
    if (!canvasSearchQuery || !canvasSearchCursor || !canvasSearchHasMore || canvasSearchLoading) return;
    setCanvasSearchLoading(true);
    try {
      const page = await listCanvasPage({ limit: 50, cursor: canvasSearchCursor, query: canvasSearchQuery });
      setCanvasSearchResults((current) => {
        const byId = new Map(current.map((canvas) => [canvas.id, canvas]));
        for (const canvas of page.items) byId.set(canvas.id, canvas);
        return [...byId.values()];
      });
      setCanvasSearchCursor(page.nextCursor);
      setCanvasSearchHasMore(page.hasMore);
      setCanvasSearchUnavailable(page.searchUnavailable);
    } catch (error: any) {
      setCanvasSearchError(error?.message || '继续搜索画布失败');
    } finally {
      setCanvasSearchLoading(false);
    }
  }, [canvasSearchCursor, canvasSearchHasMore, canvasSearchLoading, canvasSearchQuery]);

  const clearCanvasSearch = useCallback(() => {
    setCanvasSearchDraft('');
    setCanvasSearchQuery('');
    setCanvasSearchResults([]);
    setCanvasSearchCursor(null);
    setCanvasSearchHasMore(false);
    setCanvasSearchUnavailable(false);
    setCanvasSearchError('');
    setCanvasScrollTop(0);
  }, []);

  const handleSelectCanvas = useCallback((id: string) => setActive(id), [setActive]);
  const handleEditingNameChange = useCallback((name: string) => setEditingName(name), []);
  const cancelEdit = useCallback(() => setEditingId(null), []);
  const requestDelete = useCallback((id: string) => setConfirmDelete(id), []);
  const cancelDelete = useCallback(() => setConfirmDelete(null), []);

  const toggle = (key: string) => setCollapsed((s) => ({ ...s, [key]: !s[key] }));

  const renderNode = (n: NodeMeta) => {
    const themedIcon = visualStyle === 'op'
      ? OP_ICON_BY_TYPE[n.type] || n.icon
      : visualStyle === 'naruto'
        ? NARUTO_ICON_BY_TYPE[n.type] || n.icon
      : visualStyle === 'eva'
        ? EVA_ICON_BY_TYPE[n.type] || n.icon
      : visualStyle === 'yyh'
        ? YYH_ICON_BY_TYPE[n.type] || n.icon
      : visualStyle === 'slamdunk'
        ? SLAMDUNK_ICON_BY_TYPE[n.type] || n.icon
      : visualStyle === 'soccer-hero'
        ? SOCCER_ICON_BY_TYPE[n.type] || n.icon
      : visualStyle === 'dragon-ball'
        ? DRAGON_BALL_ICON_BY_TYPE[n.type] || n.icon
      : visualStyle === 'saint-seiya'
        ? SAINT_SEIYA_ICON_BY_TYPE[n.type] || n.icon
      : visualStyle === 'farm-story'
        ? FARM_STORY_ICON_BY_TYPE[n.type] || n.icon
        : n.icon;
    const Icon = (Icons as any)[themedIcon] || Icons.Box;
    const colorHex = COLOR_HEX[n.color] || COLOR_HEX.slate;
    return (
      <button
        key={n.type}
        onClick={() => onAddNode(n.type)}
        title={n.description}
        className={`t8-sidebar-node w-full text-left flex items-center gap-2 px-2 py-1.5 transition-colors text-xs ${
          isPixel
            ? 'px-row'
            : `rounded-md ${
                isDark
                  ? 'hover:bg-white/10 text-zinc-200'
                  : 'hover:bg-black/5 text-zinc-800'
              }`
        }`}
      >
        <span
          className={`w-6 h-6 flex items-center justify-center flex-shrink-0 ${
            isPixel ? 'rounded-[6px] border-2' : 'rounded'
          }`}
          style={
            isPixel
              ? {
                  background: colorHex,
                  color: '#1A1410',
                  borderColor: '#1A1410',
                }
              : {
                  background: colorHex + '22',
                  color: colorHex,
                  boxShadow: `inset 0 0 0 1px ${colorHex}55`,
                }
          }
        >
          <Icon size={13} />
        </span>
        <span className="flex-1 min-w-0 truncate">{n.label}</span>
      </button>
    );
  };

  // 搜索过滤
  const filterNodes = (nodes: NodeMeta[]) => {
    if (!keyword.trim()) return nodes;
    const k = keyword.toLowerCase();
    return nodes.filter(
      (n) =>
        n.label.toLowerCase().includes(k) ||
        n.type.toLowerCase().includes(k) ||
        n.description.toLowerCase().includes(k)
    );
  };

  return (
    <div
      className={`t8-sidebar w-64 flex flex-col border-r overflow-hidden ${
        isPixel
          ? 'px-panel'
          : isDark
            ? 'bg-zinc-900 border-white/10'
            : 'bg-white border-black/10'
      }`}
    >
      {/* 画布管理(可折叠) */}
      <div
        className={`border-b ${
          isPixel ? 'border-[#1A1410]/80' : isDark ? 'border-white/10' : 'border-black/10'
        }`}
      >
        <div
          className={`flex items-center gap-1 px-2 py-2 ${
            isPixel ? '' : isDark ? 'text-white/70' : 'text-zinc-700'
          }`}
        >
          <button
            onClick={() => setCanvasPanelOpen((v) => !v)}
            className={`flex items-center gap-1 flex-1 text-left text-[11px] font-semibold uppercase tracking-wider ${
              isPixel
                ? 'px-group-title'
                : isDark
                  ? 'hover:text-white'
                  : 'hover:text-zinc-900'
            }`}
          >
            {canvasPanelOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            <FolderOpen size={12} />
            <span>画布</span>
            <span className="opacity-60 ml-1 normal-case">{displayedCanvasTotal}</span>
          </button>
          <button
            onClick={handleCreateCanvas}
            className={
              isPixel
                ? 'px-btn px-btn--icon px-btn--mint'
                : `p-1 rounded-md ${
                    isDark
                      ? 'hover:bg-white/10 text-white/70 hover:text-white'
                      : 'hover:bg-black/10 text-zinc-700'
                  }`
            }
            title="新建画布"
          >
            <Plus size={13} />
          </button>
        </div>
        {canvasPanelOpen && (
          <div className="px-2 pb-2">
            <form
              className={`mb-1 flex items-center gap-1 rounded px-1.5 py-1 ${
                isPixel ? 'px-input' : isDark ? 'bg-white/5 text-white/60' : 'bg-black/5 text-zinc-600'
              }`}
              onSubmit={(event) => {
                event.preventDefault();
                void handleCanvasSearch();
              }}
            >
              <Search size={11} className="shrink-0 opacity-60" />
              <input
                value={canvasSearchDraft}
                onChange={(event) => setCanvasSearchDraft(event.target.value)}
                placeholder="搜索全部画布，回车确认"
                aria-label="搜索全部画布"
                className="min-w-0 flex-1 bg-transparent text-[10px] outline-none"
              />
              {canvasSearchLoading && <Loader2 size={10} className="shrink-0 animate-spin" />}
              {(canvasSearchDraft || canvasSearchQuery) && !canvasSearchLoading && (
                <button type="button" onClick={clearCanvasSearch} title="清除画布搜索">
                  <X size={10} />
                </button>
              )}
              <button
                type="submit"
                disabled={canvasSearchLoading}
                className="shrink-0 rounded px-1 py-0.5 text-[9px] hover:bg-white/10"
              >
                搜索
              </button>
            </form>
            {canvasLoading && (
              <div
                className={`flex items-center gap-2 px-2 py-2 text-[11px] ${
                  isPixel ? '' : isDark ? 'text-white/40' : 'text-zinc-500'
                }`}
              >
                <Loader2 size={12} className="animate-spin" /> 加载中...
              </div>
            )}
            {canvasCatalogPartial && canvasRecovery?.status === 'running' && (
              <div
                className={`px-2 pb-1 text-[10px] ${isPixel ? '' : isDark ? 'text-amber-300/70' : 'text-amber-700'}`}
                role="status"
              >
                正在后台修复画布目录 {canvasRecovery.scanned}/{canvasRecovery.total || '?'}
              </div>
            )}
            {canvasSearchUnavailable && canvasSearchQuery && (
              <div className={`px-2 pb-1 text-[10px] ${isDark ? 'text-amber-300/70' : 'text-amber-700'}`}>
                目录索引正在修复，当前搜索结果可能不完整；修复完成后可重新搜索。
              </div>
            )}
            {canvasSearchError && (
              <div className={`px-2 pb-1 text-[10px] ${isDark ? 'text-red-300/75' : 'text-red-700'}`} role="alert">
                {canvasSearchError}
              </div>
            )}
            {!canvasLoading
              && canvases.length === 0
              && canvasRecovery?.status !== 'running' && (
              <div
                className={`text-center py-3 text-[11px] ${
                  isPixel ? '' : isDark ? 'text-white/40' : 'text-zinc-500'
                }`}
              >
                <p>还没有画布</p>
                <button
                  onClick={handleCreateCanvas}
                  className={
                    isPixel
                      ? 'mt-1.5 px-btn px-btn--sm px-btn--mint'
                      : 'mt-1.5 px-2 py-0.5 rounded-md bg-emerald-500/20 text-emerald-300 text-[10px] hover:bg-emerald-500/30'
                  }
                >
                  + 新建第一个画布
                </button>
              </div>
            )}
            {!canvasLoading && !canvasSearchLoading && !canvasSearchError && canvasSearchQuery && displayedCanvases.length === 0 && (
              <div className={`px-2 py-2 text-center text-[10px] ${
                isDark ? 'text-white/40' : 'text-zinc-500'
              }`}>
                没有匹配的画布
              </div>
            )}
            {displayedCanvases.length > 0 && (
              <div
                onScroll={handleCanvasListScroll}
                className="overflow-y-auto scrollbar-hide"
                style={{ height: Math.min(CANVAS_VIEWPORT_HEIGHT, displayedCanvases.length * CANVAS_ROW_HEIGHT) }}
                data-canvas-windowed-list="true"
              >
                <div
                  className="relative"
                  style={{ height: displayedCanvases.length * CANVAS_ROW_HEIGHT }}
                >
                  {visibleCanvases.map((canvas, visibleIndex) => {
                    const absoluteIndex = canvasVisibleRange.start + visibleIndex;
                    const isActive = canvas.id === activeId;
                    return (
                      <div
                        key={canvas.id}
                        className="absolute left-0 right-0"
                        style={{ top: absoluteIndex * CANVAS_ROW_HEIGHT, height: CANVAS_ROW_HEIGHT }}
                      >
                        <CanvasCatalogRow
                          canvas={canvas}
                          isActive={isActive}
                          isEditing={editingId === canvas.id}
                          needsDeleteConfirm={confirmDelete === canvas.id}
                          hasCompletionNotice={!isActive && completionNoticeSet.has(canvas.id)}
                          editingName={editingName}
                          isDark={isDark}
                          isPixel={isPixel}
                          onSelect={handleSelectCanvas}
                          onEditingNameChange={handleEditingNameChange}
                          onStartEdit={startEdit}
                          onSubmitEdit={submitEdit}
                          onCancelEdit={cancelEdit}
                          onRequestDelete={requestDelete}
                          onConfirmDelete={handleDeleteCanvas}
                          onCancelDelete={cancelDelete}
                        />
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
            {canvasHasMore && !canvasSearchQuery && (
              <button
                type="button"
                onClick={() => void loadMoreCanvases()}
                disabled={canvasLoadingMore}
                className={`mt-1 w-full flex items-center justify-center gap-1 py-1 text-[10px] ${
                  isPixel ? 'px-btn px-btn--sm' : isDark ? 'text-white/45 hover:text-white/70' : 'text-zinc-500 hover:text-zinc-700'
                }`}
              >
                {canvasLoadingMore ? <Loader2 size={10} className="animate-spin" /> : <ChevronDown size={10} />}
                {canvasLoadingMore ? '加载中...' : `加载更多（已载入 ${canvases.length}）`}
              </button>
            )}
            {canvasSearchQuery && canvasSearchHasMore && (
              <button
                type="button"
                onClick={() => void handleLoadMoreCanvasSearch()}
                disabled={canvasSearchLoading}
                className={`mt-1 w-full flex items-center justify-center gap-1 py-1 text-[10px] ${
                  isPixel ? 'px-btn px-btn--sm' : isDark ? 'text-white/45 hover:text-white/70' : 'text-zinc-500 hover:text-zinc-700'
                }`}
              >
                {canvasSearchLoading ? <Loader2 size={10} className="animate-spin" /> : <ChevronDown size={10} />}
                {canvasSearchLoading ? '搜索中...' : `加载更多结果（已载入 ${canvasSearchResults.length}）`}
              </button>
            )}
          </div>
        )}
      </div>

      {/* 搜索框 */}
      <div
        className={`t8-sidebar-search-row p-2 border-b ${
          isPixel ? 'border-[#1A1410]/80' : isDark ? 'border-white/10' : 'border-black/10'
        }`}
      >
        <div
          className={`t8-sidebar-search-box flex items-center gap-2 px-2 py-1.5 ${
            isPixel
              ? 'px-input rounded-[10px]'
              : `rounded-md ${isDark ? 'bg-white/5' : 'bg-black/5'}`
          }`}
        >
          <Search size={14} className="opacity-60" />
          <input
            type="text"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="搜索节点..."
            className={`flex-1 bg-transparent outline-none text-xs ${
              isPixel
                ? ''
                : isDark
                  ? 'text-white placeholder:text-white/30'
                  : 'text-zinc-900 placeholder:text-zinc-400'
            }`}
          />
        </div>
      </div>

      {/* 节点分组列表 */}
      <div className="flex-1 overflow-y-auto p-2 space-y-1 scrollbar-hide">
        {Object.entries(NODE_GROUPS).map(([key, group]) => {
          const visible = filterNodes(group.nodes);
          if (visible.length === 0) return null;
          const isCollapsed = collapsed[key];
          return (
            <div key={key} className="mb-1">
              <button
                onClick={() => toggle(key)}
                className={`w-full flex items-center gap-1 px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wider ${
                  isPixel
                    ? 'px-group-title'
                    : isDark
                      ? 'text-white/50 hover:text-white/80'
                      : 'text-zinc-500 hover:text-zinc-800'
                }`}
              >
                {isCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                <span className="flex-1 text-left">{group.label}</span>
                <span className="opacity-60">{visible.length}</span>
              </button>
              {!isCollapsed && <div className="space-y-0.5 mt-0.5">{visible.map(renderNode)}</div>}
            </div>
          );
        })}
      </div>

      {/* 底部版本信息 */}
      <div
        className={`px-3 py-2 border-t text-[10px] ${
          isPixel
            ? 'border-[#1A1410]/80'
            : isDark
              ? 'border-white/10 text-white/30'
              : 'border-black/10 text-zinc-400'
        }`}
      >
        {isPixel ? (
          <span className="px-chip px-chip--muted">T8 · v{__APP_VERSION__}</span>
        ) : (
          <>T8-penguin-canvas · v{__APP_VERSION__}</>
        )}
      </div>
    </div>
  );
}
