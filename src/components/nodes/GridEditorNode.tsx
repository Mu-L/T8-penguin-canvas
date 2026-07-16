import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import {
  AlertCircle,
  ArrowDownUp,
  Grid3x3,
  ImagePlus,
  Layers,
  Loader2,
  Plus,
  RefreshCcw,
  Scissors,
  Sparkles,
  X,
} from 'lucide-react';
import { useRunTrigger } from '../../hooks/useRunTrigger';
import { requestCanvasNodeRun } from '../../utils/canvasRunRequest';
import { opGridCompose, uploadFileBlob } from '../../services/imageOps';
import {
  GRID_EDITOR_CUSTOM_RATIO_VALUE,
  GRID_EDITOR_PRESETS,
  GRID_EDITOR_RATIO_PRESETS,
  buildGridComposeRequest,
  buildGridEditorItems,
  createGridEditorSlots,
  gridEditorCellDropTargetId,
  gridEditorRatioSelectValue,
  moveGridEditorItem,
  normalizeGridEditorConfig,
  parseGridEditorCellDropTargetId,
  placeGridEditorItemsAtSlot,
  rowsNeededForItems,
  splitGridEditorItems,
  type GridEditorConfig,
  type GridEditorFit,
  type GridEditorItem,
  type GridEditorSlotOrder,
} from '../../utils/gridEditor';
import {
  MATERIAL_DROP_EVENT,
  useDragMaterialStore,
  type MaterialDropEventDetail,
  type MaterialPayload,
} from '../../stores/dragMaterial';
import { useHasAutoOutput } from './useHasAutoOutput';
import { useUpdateNodeData } from './useUpdateNodeData';
import { useUpstreamMaterials } from './useUpstreamMaterials';
import SmartImage from '../SmartImage';

const COLOR = '#fb923c';

const isRecord = (value: unknown): value is Record<string, any> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const toItemList = (value: unknown): GridEditorItem[] => {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isRecord)
    .map((item) => ({
      id: String(item.id || ''),
      url: String(item.url || ''),
      title: typeof item.title === 'string' ? item.title : undefined,
      caption: typeof item.caption === 'string' ? item.caption : undefined,
      origin: item.origin === 'upstream' ? ('upstream' as const) : ('local' as const),
    }))
    .filter((item) => item.id && item.url);
};

const toStringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.map((item) => String(item || '')).filter(Boolean) : [];

const toSlotOrder = (value: unknown): GridEditorSlotOrder =>
  Array.isArray(value)
    ? value.map((item) => {
        const id = typeof item === 'string' ? item.trim() : '';
        return id || null;
      })
    : [];

const toCaptionMap = (value: unknown): Record<string, string> => {
  if (!isRecord(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, caption] of Object.entries(value)) {
    const id = String(key || '').trim();
    if (!id || typeof caption !== 'string') continue;
    out[id] = caption.slice(0, 140);
  }
  return out;
};

const fitLabel = (fit: GridEditorFit) => {
  if (fit === 'adaptive') return '自适应';
  if (fit === 'contain') return '完整留白';
  if (fit === 'fill') return '拉伸填充';
  return '裁切铺满';
};

const controlStyle: CSSProperties = {
  background: 'var(--t8-bg-panel-elevated, rgba(255,255,255,.06))',
  border: '1px solid var(--t8-border, rgba(255,255,255,.16))',
  color: 'var(--t8-text-main, #f8fafc)',
};

const subtleTextStyle: CSSProperties = {
  color: 'var(--t8-text-muted, rgba(248,250,252,.62))',
};

const cellObjectFit = (fit: GridEditorFit): CSSProperties['objectFit'] => {
  if (fit === 'adaptive' || fit === 'contain') return 'contain';
  if (fit === 'fill') return 'fill';
  return 'cover';
};

const IMAGE_FILE_EXT_RE = /\.(png|jpe?g|webp|gif|bmp|avif)$/i;

const isImageFile = (file: File) => file.type.startsWith('image/') || IMAGE_FILE_EXT_RE.test(file.name || '');

const imageFilesFromFileList = (files: FileList | File[]): File[] => Array.from(files || []).filter(isImageFile);

const dragEventHasImageFile = (event: ReactDragEvent<HTMLElement>) => {
  const transfer = event.dataTransfer;
  if (!transfer) return false;
  const items = Array.from(transfer.items || []);
  if (items.some((item) => item.kind === 'file' && (item.type.startsWith('image/') || !item.type))) return true;
  return imageFilesFromFileList(transfer.files || []).length > 0;
};

const safeDecodeFileName = (value: string) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

const titleFromImageUrl = (url: string) => {
  try {
    const parsed = new URL(url, window.location.origin);
    return safeDecodeFileName(parsed.pathname.split('/').pop() || '拖入图像');
  } catch {
    return safeDecodeFileName(url.split('/').pop() || '拖入图像');
  }
};

const GridEditorNode = ({ id, data, selected }: NodeProps) => {
  const d = (data as any) || {};
  const update = useUpdateNodeData(id);
  const upstream = useUpstreamMaterials(id);
  const hasAutoOutput = useHasAutoOutput(id);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const sortScopeRef = useRef(`grid-editor-${id}-${Math.random().toString(36).slice(2)}`);
  const sortDragRef = useRef<{ activeId: string; overId: string | null; moved: boolean } | null>(null);
  const sortStartRef = useRef<{ x: number; y: number } | null>(null);
  const sortCleanupRef = useRef<(() => void) | null>(null);
  const [sortDrag, setSortDrag] = useState<{ activeId: string; overId: string | null; moved: boolean } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dropCellIndex, setDropCellIndex] = useState<number | null>(null);
  const materialHoverTargetId = useDragMaterialStore((s) => s.hoverTargetId);
  const materialHoverAccepts = useDragMaterialStore((s) => s.hoverAccepts);
  const [gridDimensionDrafts, setGridDimensionDrafts] = useState<{ width: string | null; height: string | null }>({
    width: null,
    height: null,
  });

  const config = useMemo<GridEditorConfig>(
    () =>
      normalizeGridEditorConfig({
        rows: d.gridEditorRows,
        cols: d.gridEditorCols,
        width: d.gridEditorWidth,
        height: d.gridEditorHeight,
        gap: d.gridEditorGap,
        background: d.gridEditorBackground,
        fit: d.gridEditorFit,
        showIndexes: d.gridEditorShowIndexes,
        showCaptions: d.gridEditorShowCaptions,
        captionHeight: d.gridEditorCaptionHeight,
        captionTextColor: d.gridEditorCaptionTextColor,
        captionBackground: d.gridEditorCaptionBackground,
      }),
    [
      d.gridEditorBackground,
      d.gridEditorCaptionBackground,
      d.gridEditorCaptionHeight,
      d.gridEditorCaptionTextColor,
      d.gridEditorCols,
      d.gridEditorFit,
      d.gridEditorGap,
      d.gridEditorHeight,
      d.gridEditorRows,
      d.gridEditorShowCaptions,
      d.gridEditorShowIndexes,
      d.gridEditorWidth,
    ],
  );

  const hiddenIds = useMemo(() => new Set(toStringArray(d.gridEditorHiddenIds)), [d.gridEditorHiddenIds]);
  const captionMap = useMemo(() => toCaptionMap(d.gridEditorCaptions), [d.gridEditorCaptions]);
  const localItems = useMemo(() => toItemList(d.gridEditorLocalItems), [d.gridEditorLocalItems]);
  const order = useMemo(() => toStringArray(d.gridEditorOrder), [d.gridEditorOrder]);
  const slotOrder = useMemo(() => toSlotOrder(d.gridEditorSlotOrder), [d.gridEditorSlotOrder]);
  const upstreamItems = useMemo<GridEditorItem[]>(
    () =>
      upstream.images
        .filter((item) => !hiddenIds.has(item.id))
        .map((item) => ({
          id: item.id,
          url: item.url,
          title: item.label || item.url.split('/').pop() || '上游图像',
          origin: 'upstream',
        })),
    [hiddenIds, upstream.images],
  );
  const items = useMemo(
    () => buildGridEditorItems(upstreamItems, localItems, order),
    [localItems, order, upstreamItems],
  );
  const itemsWithCaptions = useMemo(
    () =>
      items.map((item) => ({
        ...item,
        caption: Object.prototype.hasOwnProperty.call(captionMap, item.id)
          ? captionMap[item.id]
          : (item.caption || item.title || ''),
      })),
    [captionMap, items],
  );
  const itemIds = useMemo(() => items.map((item) => item.id), [items]);
  const slots = useMemo(() => createGridEditorSlots(itemsWithCaptions, config, slotOrder), [config, itemsWithCaptions, slotOrder]);
  const totalSlots = config.rows * config.cols;
  const overflowCount = Math.max(0, items.length - totalSlots);
  const status: 'idle' | 'running' | 'success' | 'error' = d.status || 'idle';
  const composedUrl = typeof d.imageUrl === 'string' ? d.imageUrl : '';
  const splitUrls = Array.isArray(d.imageUrls) ? d.imageUrls.filter((url: unknown) => typeof url === 'string') : [];

  const patchConfig = (patch: Partial<GridEditorConfig> & { ratioMode?: string }) => {
    const { ratioMode, ...configPatch } = patch;
    const next = normalizeGridEditorConfig({ ...config, ...configPatch });
    if ('width' in patch || 'height' in patch) {
      setGridDimensionDrafts((prev) => ({
        width: 'width' in patch ? null : prev.width,
        height: 'height' in patch ? null : prev.height,
      }));
    }
    const payload: Record<string, unknown> = {
      gridEditorRows: next.rows,
      gridEditorCols: next.cols,
      gridEditorWidth: next.width,
      gridEditorHeight: next.height,
      gridEditorGap: next.gap,
      gridEditorBackground: next.background,
      gridEditorFit: next.fit,
      gridEditorShowIndexes: next.showIndexes,
      gridEditorShowCaptions: next.showCaptions,
      gridEditorCaptionHeight: next.captionHeight,
      gridEditorCaptionTextColor: next.captionTextColor,
      gridEditorCaptionBackground: next.captionBackground,
    };
    if (ratioMode !== undefined) payload.gridEditorRatioMode = ratioMode;
    update(payload);
  };

  const setGridDimensionDraft = (key: 'width' | 'height', value: string) => {
    setGridDimensionDrafts((prev) => ({ ...prev, [key]: value }));
  };

  const commitGridDimensionDraft = (key: 'width' | 'height') => {
    const raw = gridDimensionDrafts[key];
    if (raw === null) return;
    setGridDimensionDrafts((prev) => ({ ...prev, [key]: null }));
    const value = Number.parseInt(raw, 10);
    if (!Number.isFinite(value)) return;
    patchConfig({ [key]: value, ratioMode: GRID_EDITOR_CUSTOM_RATIO_VALUE });
  };

  const openFilePicker = () => fileInputRef.current?.click();

  const commitItemsToCell = useCallback(
    (cellIndex: number, incomingItems: GridEditorItem[]) => {
      const cleanIncoming = incomingItems.filter((item) => item.id && item.url);
      if (cleanIncoming.length === 0) return;
      const placement = placeGridEditorItemsAtSlot(items, config, slotOrder, cleanIncoming, cellIndex);
      if (placement.placedIds.length === 0) return;
      const incomingIds = new Set(cleanIncoming.map((item) => item.id));
      const replacedIds = new Set(placement.replacedIds);
      const localIds = new Set(localItems.map((item) => item.id));
      const nextLocal = [
        ...localItems.filter((item) => !incomingIds.has(item.id) && !replacedIds.has(item.id)),
        ...cleanIncoming.map((item) => ({ ...item, origin: 'local' as const })),
      ];
      const nextHiddenIds = new Set(hiddenIds);
      for (const replacedId of replacedIds) {
        if (!localIds.has(replacedId)) nextHiddenIds.add(replacedId);
      }
      update({
        gridEditorLocalItems: nextLocal,
        gridEditorOrder: placement.order,
        gridEditorSlotOrder: placement.slotOrder,
        gridEditorHiddenIds: Array.from(nextHiddenIds),
      });
    },
    [config, hiddenIds, items, localItems, slotOrder, update],
  );

  const uploadFilesToCell = useCallback(
    async (cellIndex: number, files: File[]) => {
      const imageFiles = files.filter(isImageFile);
      if (imageFiles.length === 0) return;
      setUploading(true);
      setError(null);
      try {
        const stamp = Date.now();
        const uploaded = await Promise.all(
          imageFiles.map(async (file, index) => {
            const url = await uploadFileBlob(file, file.name);
            return {
              id: `local:cell:${stamp}:${cellIndex}:${index}:${url}`,
              url,
              title: file.name,
              origin: 'local' as const,
            };
          }),
        );
        commitItemsToCell(cellIndex, uploaded);
      } catch (e: any) {
        setError(e?.message || '拖入上传失败');
      } finally {
        setUploading(false);
        setDropCellIndex(null);
      }
    },
    [commitItemsToCell],
  );

  const handleFiles = async (files: File[]) => {
    if (files.length === 0) return;
    setUploading(true);
    setError(null);
    try {
      const uploaded = await Promise.all(
        files.map(async (file, index) => {
          const url = await uploadFileBlob(file, file.name);
          return {
            id: `local:${Date.now()}:${index}:${url}`,
            url,
            title: file.name,
            origin: 'local' as const,
          };
        }),
      );
      const nextLocal = [...localItems, ...uploaded];
      update({
        gridEditorLocalItems: nextLocal,
        gridEditorOrder: [...itemIds, ...uploaded.map((item) => item.id)],
      });
    } catch (e: any) {
      setError(e?.message || '上传失败');
    } finally {
      setUploading(false);
    }
  };

  const onFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const files = imageFilesFromFileList(event.target.files || []);
    event.currentTarget.value = '';
    handleFiles(files);
  };

  const handleCellDragOver = (event: ReactDragEvent<HTMLDivElement>, cellIndex: number) => {
    if (!dragEventHasImageFile(event)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'copy';
    setDropCellIndex(cellIndex);
  };

  const handleCellDragLeave = (event: ReactDragEvent<HTMLDivElement>, cellIndex: number) => {
    if (dropCellIndex !== cellIndex) return;
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return;
    setDropCellIndex(null);
  };

  const handleCellFileDrop = (event: ReactDragEvent<HTMLDivElement>, cellIndex: number) => {
    if (!dragEventHasImageFile(event)) return;
    event.preventDefault();
    event.stopPropagation();
    void uploadFilesToCell(cellIndex, imageFilesFromFileList(event.dataTransfer.files || []));
  };

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<MaterialDropEventDetail>).detail;
      const cellIndex = parseGridEditorCellDropTargetId(detail?.targetNodeId, id);
      const payload: MaterialPayload | undefined = detail?.payload;
      if (cellIndex === null || payload?.kind !== 'image' || !payload.url) return;
      const stamp = Date.now();
      commitItemsToCell(cellIndex, [
        {
          id: `local:drag:${stamp}:${cellIndex}:${payload.url}`,
          url: payload.url,
          title: titleFromImageUrl(payload.url),
          origin: 'local',
        },
      ]);
      setDropCellIndex(null);
    };
    window.addEventListener(MATERIAL_DROP_EVENT, handler as EventListener);
    return () => window.removeEventListener(MATERIAL_DROP_EVENT, handler as EventListener);
  }, [commitItemsToCell, id]);

  const removeItem = (item: GridEditorItem) => {
    const nextOrder = itemIds.filter((itemId) => itemId !== item.id);
    const nextSlotOrder = slotOrder.length
      ? slots.map((slot) => (slot?.id === item.id ? null : slot?.id || null))
      : undefined;
    const slotPatch = nextSlotOrder ? { gridEditorSlotOrder: nextSlotOrder } : {};
    if (item.origin === 'local') {
      update({
        gridEditorLocalItems: localItems.filter((local) => local.id !== item.id),
        gridEditorOrder: nextOrder,
        ...slotPatch,
      });
      return;
    }
    update({
      gridEditorHiddenIds: Array.from(new Set([...hiddenIds, item.id])),
      gridEditorOrder: nextOrder,
      ...slotPatch,
    });
  };

  const restoreHidden = () => update({ gridEditorHiddenIds: [] });

  const setItemCaption = (item: GridEditorItem, caption: string) => {
    update({
      gridEditorCaptions: {
        ...captionMap,
        [item.id]: caption.slice(0, 140),
      },
    });
  };

  const setSortDragState = (next: typeof sortDrag) => {
    sortDragRef.current = next;
    setSortDrag(next);
  };

  const cleanupSortListeners = () => {
    sortCleanupRef.current?.();
    sortCleanupRef.current = null;
  };

  const findOverItemId = (clientX: number, clientY: number) => {
    const scope = sortScopeRef.current;
    for (const el of document.elementsFromPoint(clientX, clientY)) {
      if (!(el instanceof HTMLElement)) continue;
      const target = el.closest(`[data-grid-editor-scope="${scope}"][data-grid-editor-item-id]`) as HTMLElement | null;
      if (target?.dataset.gridEditorItemId) return target.dataset.gridEditorItemId;
    }
    return null;
  };

  const finishSortDrag = () => {
    const current = sortDragRef.current;
    cleanupSortListeners();
    if (current?.moved && current.overId && current.activeId !== current.overId) {
      if (slotOrder.length) {
        const nextSlotOrder = slots.map((slot) => slot?.id || null);
        const activeIndex = nextSlotOrder.indexOf(current.activeId);
        const overIndex = nextSlotOrder.indexOf(current.overId);
        if (activeIndex >= 0 && overIndex >= 0) {
          const [movedId] = nextSlotOrder.splice(activeIndex, 1);
          nextSlotOrder.splice(overIndex, 0, movedId || null);
          const slottedIds = Array.from(new Set(nextSlotOrder.filter((itemId): itemId is string => Boolean(itemId))));
          update({
            gridEditorSlotOrder: nextSlotOrder,
            gridEditorOrder: [...slottedIds, ...itemIds.filter((itemId) => !slottedIds.includes(itemId))],
          });
        }
      } else {
        update({ gridEditorOrder: moveGridEditorItem(itemIds, current.activeId, current.overId) });
      }
    }
    sortStartRef.current = null;
    setSortDragState(null);
  };

  const beginSortDrag = (event: ReactPointerEvent<HTMLDivElement>, item: GridEditorItem) => {
    if (items.length <= 1) return;
    if ((event.target as HTMLElement | null)?.closest('button')) return;
    event.preventDefault();
    event.stopPropagation();
    cleanupSortListeners();
    sortStartRef.current = { x: event.clientX, y: event.clientY };
    setSortDragState({ activeId: item.id, overId: item.id, moved: false });

    const onMove = (nativeEvent: globalThis.PointerEvent) => {
      const current = sortDragRef.current;
      const start = sortStartRef.current;
      if (!current || !start) return;
      nativeEvent.preventDefault();
      nativeEvent.stopPropagation();
      const moved = current.moved || Math.hypot(nativeEvent.clientX - start.x, nativeEvent.clientY - start.y) >= 3;
      const overId = findOverItemId(nativeEvent.clientX, nativeEvent.clientY) || current.overId;
      if (moved !== current.moved || overId !== current.overId) {
        setSortDragState({ ...current, moved, overId });
      }
    };
    const onUp = (nativeEvent: globalThis.PointerEvent) => {
      nativeEvent.preventDefault();
      nativeEvent.stopPropagation();
      finishSortDrag();
    };
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', onUp, true);
    window.addEventListener('pointercancel', onUp, true);
    sortCleanupRef.current = () => {
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerup', onUp, true);
      window.removeEventListener('pointercancel', onUp, true);
    };
  };

  useEffect(() => () => cleanupSortListeners(), []);

  const handleSplit = () => {
    const urls = splitGridEditorItems(slots.filter((slot): slot is GridEditorItem => !!slot));
    if (urls.length === 0) {
      setError('暂无可拆分图像');
      return;
    }
    setError(null);
    update({
      status: 'success',
      error: null,
      imageUrl: urls[0],
      urls,
      imageUrls: urls,
      gridEditorLastAction: 'split',
    });
  };

  const handleRun = async () => {
    setError(null);
    const filled = slots.filter((slot): slot is GridEditorItem => !!slot);
    if (filled.length === 0) {
      setError('至少需要 1 张图像');
      return;
    }
    update({ status: 'running', error: null });
    try {
      const request = buildGridComposeRequest(itemsWithCaptions, config, slotOrder);
      const result = await opGridCompose(request);
      update({
        status: 'success',
        error: null,
        imageUrl: result.imageUrl,
        urls: [result.imageUrl],
        imageUrls: [result.imageUrl],
        gridEditorLastAction: 'compose',
        gridEditorLastCompose: {
          rows: result.rows,
          cols: result.cols,
          width: result.width,
          height: result.height,
          gap: result.gap,
        },
      });
    } catch (e: any) {
      const msg = e?.message || '生成宫格失败';
      setError(msg);
      update({ status: 'error', error: msg });
    }
  };

  useRunTrigger(id, handleRun);

  const previewGap = Math.min(14, Math.max(0, Math.round(config.gap / 8)));
  const previewGridStyle: CSSProperties = {
    display: 'grid',
    gridTemplateColumns: `repeat(${config.cols}, minmax(0, 1fr))`,
    gridTemplateRows: `repeat(${config.rows}, minmax(0, 1fr))`,
    gap: previewGap,
    background: config.background,
    aspectRatio: `${config.width} / ${config.height}`,
    minHeight: 180,
  };
  const ratioSelectValue = gridEditorRatioSelectValue(config.width, config.height, d.gridEditorRatioMode);

  return (
    <div
      className="t8-node relative overflow-visible rounded-xl border-2 transition-all"
      style={{
        width: 520,
        borderColor: selected ? COLOR : 'var(--t8-border-strong, rgba(255,255,255,.20))',
        boxShadow: selected ? `0 0 0 1px ${COLOR}, 0 12px 28px rgba(251,146,60,.16)` : undefined,
      }}
    >
      <Handle type="target" position={Position.Left} style={{ background: COLOR, border: 0 }} />
      <Handle type="source" position={Position.Right} style={{ background: COLOR, border: 0 }} />

      <div className="t8-node-header flex items-center gap-2 px-3 py-2">
        <div
          className="flex h-7 w-7 items-center justify-center rounded-lg"
          style={{
            background: 'color-mix(in srgb, var(--t8-accent, #fb923c) 18%, transparent)',
            border: '1px solid var(--t8-border-strong, rgba(255,255,255,.26))',
            color: 'var(--t8-text-main, #f8fafc)',
          }}
        >
          <Grid3x3 size={15} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-bold" style={{ color: 'var(--t8-text-main, #f8fafc)' }}>
            宫格编辑
          </div>
          <div className="truncate text-[10px]" style={subtleTextStyle}>
            {config.cols}×{config.rows} · {config.width}×{config.height} · {fitLabel(config.fit)}
          </div>
        </div>
        <div className="rounded-full px-2 py-0.5 text-[10px] font-bold" style={controlStyle}>
          {slots.filter(Boolean).length}/{totalSlots}
        </div>
      </div>

      <div
        className="nodrag nowheel space-y-2.5 p-3"
        onMouseDown={(e) => e.stopPropagation()}
        onWheelCapture={(e) => e.stopPropagation()}
        onWheel={(e) => e.stopPropagation()}
      >
        <input ref={fileInputRef} type="file" accept="image/*" multiple className="hidden" onChange={onFileChange} />

        <div className="grid grid-cols-6 gap-1.5">
          {GRID_EDITOR_PRESETS.map((preset) => (
            <button
              key={preset.label}
              type="button"
              onClick={() => patchConfig({ rows: preset.rows, cols: preset.cols })}
              className="t8-btn h-8 text-[11px]"
              style={{
                borderColor: preset.rows === config.rows && preset.cols === config.cols ? COLOR : undefined,
                background:
                  preset.rows === config.rows && preset.cols === config.cols
                    ? 'color-mix(in srgb, var(--t8-accent, #fb923c) 24%, var(--t8-bg-panel-elevated, rgba(255,255,255,.08)))'
                    : undefined,
              }}
            >
              {preset.label}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-6 gap-2">
          <label className="col-span-1 text-[10px] font-semibold" style={subtleTextStyle}>
            横
            <input
              type="number"
              min={1}
              max={12}
              value={config.cols}
              onChange={(event) => patchConfig({ cols: Number(event.target.value) })}
              className="t8-input mt-1 h-8 w-full px-2 text-xs"
            />
          </label>
          <label className="col-span-1 text-[10px] font-semibold" style={subtleTextStyle}>
            竖
            <input
              type="number"
              min={1}
              max={12}
              value={config.rows}
              onChange={(event) => patchConfig({ rows: Number(event.target.value) })}
              className="t8-input mt-1 h-8 w-full px-2 text-xs"
            />
          </label>
          <label className="col-span-2 text-[10px] font-semibold" style={subtleTextStyle}>
            比例
            <select
              value={ratioSelectValue}
              onChange={(event) => {
                if (event.target.value === GRID_EDITOR_CUSTOM_RATIO_VALUE) {
                  patchConfig({ ratioMode: GRID_EDITOR_CUSTOM_RATIO_VALUE });
                  return;
                }
                const preset = GRID_EDITOR_RATIO_PRESETS.find((item) => `${item.width}:${item.height}` === event.target.value);
                if (preset) patchConfig({ width: preset.width, height: preset.height, ratioMode: event.target.value });
              }}
              className="t8-select mt-1 h-8 w-full px-2 text-xs"
            >
              {GRID_EDITOR_RATIO_PRESETS.map((preset) => (
                <option key={preset.label} value={`${preset.width}:${preset.height}`}>
                  {preset.label}
                </option>
              ))}
              <option value={GRID_EDITOR_CUSTOM_RATIO_VALUE}>自定义</option>
            </select>
          </label>
          <label className="col-span-1 text-[10px] font-semibold" style={subtleTextStyle}>
            宽
            <input
              type="number"
              min={64}
              max={4096}
              value={gridDimensionDrafts.width ?? String(config.width)}
              onChange={(event) => setGridDimensionDraft('width', event.target.value)}
              onBlur={() => commitGridDimensionDraft('width')}
              onKeyDown={(event) => {
                if (event.key === 'Enter') event.currentTarget.blur();
              }}
              className="t8-input mt-1 h-8 w-full px-2 text-xs"
            />
          </label>
          <label className="col-span-1 text-[10px] font-semibold" style={subtleTextStyle}>
            高
            <input
              type="number"
              min={64}
              max={4096}
              value={gridDimensionDrafts.height ?? String(config.height)}
              onChange={(event) => setGridDimensionDraft('height', event.target.value)}
              onBlur={() => commitGridDimensionDraft('height')}
              onKeyDown={(event) => {
                if (event.key === 'Enter') event.currentTarget.blur();
              }}
              className="t8-input mt-1 h-8 w-full px-2 text-xs"
            />
          </label>
        </div>

        <div className="grid grid-cols-6 gap-2">
          <label className="col-span-1 text-[10px] font-semibold" style={subtleTextStyle}>
            间距
            <input
              type="number"
              min={0}
              max={160}
              value={config.gap}
              onChange={(event) => patchConfig({ gap: Number(event.target.value) })}
              className="t8-input mt-1 h-8 w-full px-2 text-xs"
            />
          </label>
          <label className="col-span-1 text-[10px] font-semibold" style={subtleTextStyle}>
            背景
            <input
              type="color"
              value={config.background}
              onChange={(event) => patchConfig({ background: event.target.value })}
              className="t8-input mt-1 h-8 w-full p-1"
            />
          </label>
          <label className="col-span-2 text-[10px] font-semibold" style={subtleTextStyle}>
            适配
            <select
              value={config.fit}
              onChange={(event) => patchConfig({ fit: event.target.value as GridEditorFit })}
              className="t8-select mt-1 h-8 w-full px-2 text-xs"
            >
              <option value="adaptive">自适应完整</option>
              <option value="cover">裁切铺满</option>
              <option value="contain">完整留白</option>
              <option value="fill">拉伸填充</option>
            </select>
          </label>
          <label
            className="col-span-1 flex items-end gap-1.5 text-[10px] font-semibold"
            style={subtleTextStyle}
            title="在预览和最终拼版图左上角显示格子编号；不用于选择或导出指定格子。"
          >
            <input
              type="checkbox"
              checked={config.showIndexes}
              onChange={(event) => patchConfig({ showIndexes: event.target.checked })}
              className="mb-2 h-4 w-4 accent-orange-400"
            />
            显示编号
          </label>
          <label className="col-span-1 flex items-end gap-1.5 text-[10px] font-semibold" style={subtleTextStyle}>
            <input
              type="checkbox"
              checked={config.showCaptions}
              onChange={(event) => patchConfig({ showCaptions: event.target.checked })}
              className="mb-2 h-4 w-4 accent-orange-400"
            />
            字幕
          </label>
        </div>

        {config.showCaptions && (
          <div className="grid grid-cols-3 gap-2">
            <label className="text-[10px] font-semibold" style={subtleTextStyle}>
              字幕高
              <input
                type="number"
                min={24}
                max={240}
                value={config.captionHeight}
                onChange={(event) => patchConfig({ captionHeight: Number(event.target.value) })}
                className="t8-input mt-1 h-8 w-full px-2 text-xs"
              />
            </label>
            <label className="text-[10px] font-semibold" style={subtleTextStyle}>
              条底色
              <input
                type="color"
                value={config.captionBackground}
                onChange={(event) => patchConfig({ captionBackground: event.target.value })}
                className="t8-input mt-1 h-8 w-full p-1"
              />
            </label>
            <label className="text-[10px] font-semibold" style={subtleTextStyle}>
              字色
              <input
                type="color"
                value={config.captionTextColor}
                onChange={(event) => patchConfig({ captionTextColor: event.target.value })}
                className="t8-input mt-1 h-8 w-full p-1"
              />
            </label>
          </div>
        )}

        <div
          className="rounded-lg border p-1.5"
          style={{
            borderColor: 'var(--t8-border, rgba(255,255,255,.14))',
            background: 'color-mix(in srgb, var(--t8-bg-panel, rgba(15,23,42,.72)) 82%, transparent)',
          }}
        >
          <div
            className="nowheel w-full overflow-auto overscroll-contain rounded-md border"
            data-grid-editor-stage
            onWheelCapture={(e) => e.stopPropagation()}
            onWheel={(e) => e.stopPropagation()}
            style={{
              borderColor: 'var(--t8-border, rgba(255,255,255,.14))',
              maxHeight: 520,
            }}
          >
            <div className="w-full" style={previewGridStyle}>
              {slots.map((item, index) => {
              const cellDropTargetId = gridEditorCellDropTargetId(id, index);
              const active = !!item && sortDrag?.activeId === item.id;
              const over = !!item && sortDrag?.overId === item.id && sortDrag.activeId !== item.id;
              const dropHover = dropCellIndex === index || (materialHoverAccepts && materialHoverTargetId === cellDropTargetId);
              return (
                <div
                  key={`${item?.id || 'empty'}-${index}`}
                  data-drop-kinds="image"
                  data-node-id={cellDropTargetId}
                  data-grid-editor-scope={item ? sortScopeRef.current : undefined}
                  data-grid-editor-item-id={item?.id}
                  onPointerDown={item ? (event) => beginSortDrag(event, item) : undefined}
                  onDragEnter={(event) => handleCellDragOver(event, index)}
                  onDragOver={(event) => handleCellDragOver(event, index)}
                  onDragLeave={(event) => handleCellDragLeave(event, index)}
                  onDrop={(event) => handleCellFileDrop(event, index)}
                  className="relative min-h-0 min-w-0 overflow-hidden"
                  style={{
                    background: dropHover
                      ? 'color-mix(in srgb, var(--t8-accent, #fb923c) 18%, rgba(15,23,42,.32))'
                      : item ? 'rgba(15,23,42,.18)' : 'rgba(255,255,255,.055)',
                    outline: dropHover
                      ? '2px solid var(--t8-accent, #fb923c)'
                      : active ? `2px solid ${COLOR}` : over ? '2px solid var(--t8-accent, #fb923c)' : '1px dashed rgba(255,255,255,.16)',
                    opacity: active && sortDrag?.moved ? 0.72 : 1,
                    cursor: item ? 'grab' : 'default',
                  }}
                >
                  {item ? (
                    <>
                      <SmartImage
                        src={item.url}
                        alt={item.title || `cell-${index + 1}`}
                        draggable={false}
                        className="h-full w-full"
                        thumbSize={320}
                        style={{ objectFit: cellObjectFit(config.fit), background: config.background }}
                      />
                      {config.showCaptions && item.caption && (
                        <div
                          className="absolute inset-x-0 bottom-0 truncate px-1.5 py-1 text-center text-[10px] font-semibold"
                          style={{
                            background: config.captionBackground,
                            color: config.captionTextColor,
                          }}
                        >
                          {item.caption}
                        </div>
                      )}
                      {config.showIndexes && (
                        <div
                          className="absolute left-1 top-1 rounded px-1.5 py-0.5 text-[10px] font-bold"
                          title={`第 ${index + 1} 格`}
                          style={{
                            background: 'rgba(17,24,39,.78)',
                            color: '#fff7ed',
                            border: '1px solid rgba(255,255,255,.42)',
                          }}
                        >
                          {index + 1}
                        </div>
                      )}
                      <button
                        type="button"
                        title="移除此格"
                        onClick={(event) => {
                          event.stopPropagation();
                          removeItem(item);
                        }}
                        className="absolute bottom-1 right-1 flex h-6 w-6 items-center justify-center rounded-md"
                        style={{
                          background: 'color-mix(in srgb, #ef4444 86%, black)',
                          color: '#fff',
                          border: '1px solid rgba(255,255,255,.55)',
                        }}
                      >
                        <X size={13} />
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      onClick={openFilePicker}
                      className="flex h-full min-h-[46px] w-full items-center justify-center"
                      style={{ color: 'var(--t8-text-dim, rgba(248,250,252,.42))' }}
                    >
                      <Plus size={20} />
                    </button>
                  )}
                  {dropHover && (
                    <div
                      className="pointer-events-none absolute inset-1 flex items-center justify-center rounded-md text-[11px] font-bold"
                      style={{
                        background: 'color-mix(in srgb, var(--t8-accent, #fb923c) 20%, transparent)',
                        color: 'var(--t8-text-main, #f8fafc)',
                        textShadow: '0 1px 2px rgba(0,0,0,.45)',
                      }}
                    >
                      松开填入
                    </div>
                  )}
                </div>
              );
            })}
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1.5 text-[10px]" style={subtleTextStyle}>
          <span className="inline-flex items-center gap-1">
            <Layers size={11} />
            上游 {upstream.images.length}
          </span>
          <span>本地 {localItems.length}</span>
          {overflowCount > 0 && (
            <button
              type="button"
              onClick={() => patchConfig({ rows: rowsNeededForItems(items.length, config.cols) })}
              className="t8-btn h-7 px-2 text-[10px]"
              style={{ borderColor: COLOR }}
            >
              超出 {overflowCount} · 自动扩容
            </button>
          )}
          {hiddenIds.size > 0 && (
            <button type="button" onClick={restoreHidden} className="t8-btn h-7 px-2 text-[10px]">
              <RefreshCcw size={11} /> 恢复{hiddenIds.size}
            </button>
          )}
          <span className="ml-auto inline-flex items-center gap-1">
            <ArrowDownUp size={11} />
            拖动排序
          </span>
        </div>

        {config.showCaptions && slots.some(Boolean) && (
          <div
            className="rounded-lg border p-2"
            style={{
              borderColor: 'var(--t8-border, rgba(255,255,255,.14))',
              background: 'color-mix(in srgb, var(--t8-bg-panel-elevated, rgba(255,255,255,.06)) 78%, transparent)',
            }}
          >
            <div className="mb-1 flex items-center gap-1 text-[10px] font-bold" style={{ color: 'var(--t8-text-main, #f8fafc)' }}>
              <Layers size={11} />
              单格字幕
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              {slots.map((item, index) => item && (
                <label key={`caption-${item.id}-${index}`} className="min-w-0 text-[10px]" style={subtleTextStyle}>
                  {index + 1}
                  <input
                    value={item.caption || ''}
                    maxLength={140}
                    onChange={(event) => setItemCaption(item, event.target.value)}
                    className="t8-input mt-0.5 h-8 w-full px-2 text-xs"
                    placeholder={item.title || `第 ${index + 1} 格`}
                  />
                </label>
              ))}
            </div>
          </div>
        )}

        <div className="grid grid-cols-3 gap-2">
          <button type="button" onClick={openFilePicker} disabled={uploading} className="t8-btn h-9 text-xs">
            {uploading ? <Loader2 size={13} className="animate-spin" /> : <ImagePlus size={13} />}
            上传
          </button>
          <button type="button" onClick={handleSplit} className="t8-btn h-9 text-xs">
            <Scissors size={13} />
            拆分
          </button>
          <button
            type="button"
            onClick={() => requestCanvasNodeRun(id)}
            disabled={status === 'running'}
            className="t8-btn t8-btn-primary h-9 text-xs"
          >
            {status === 'running' ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
            运行
          </button>
        </div>

        {(error || d.error) && (
          <div
            className="flex items-start gap-1.5 rounded-md px-2 py-1.5 text-[11px]"
            style={{
              background: 'color-mix(in srgb, #ef4444 14%, var(--t8-bg-panel-elevated, rgba(255,255,255,.06)))',
              border: '1px solid color-mix(in srgb, #ef4444 40%, transparent)',
              color: 'var(--t8-text-main, #f8fafc)',
            }}
          >
            <AlertCircle size={13} className="mt-0.5 flex-shrink-0" />
            <span className="break-all">{error || d.error}</span>
          </div>
        )}
      </div>

      {composedUrl && !hasAutoOutput && (
        <div className="border-t p-2" style={{ borderColor: 'var(--t8-border, rgba(255,255,255,.12))' }}>
          <SmartImage src={composedUrl} alt="宫格结果" className="max-h-56 w-full rounded object-contain" thumbSize={720} />
        </div>
      )}
      {splitUrls.length > 1 && !hasAutoOutput && d.gridEditorLastAction === 'split' && (
        <div className="grid grid-cols-6 gap-1 border-t p-2" style={{ borderColor: 'var(--t8-border, rgba(255,255,255,.12))' }}>
          {splitUrls.slice(0, 12).map((url: string, index: number) => (
            <SmartImage key={`${url}-${index}`} src={url} alt={`拆分 ${index + 1}`} className="aspect-square w-full rounded object-cover" thumbSize={240} />
          ))}
        </div>
      )}
    </div>
  );
};

export default memo(GridEditorNode);
