import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, MouseEvent } from 'react';
import type { AssetRef, AssetSemanticSearchHit } from '../../types/project';
import { previewImageUrl } from '../../utils/mediaPreview';
import {
  ASSET_VIRTUAL_GAP,
  assetIndexScrollTop,
  assetScrollAnchorIndex,
  calculateAssetVirtualWindow,
  type AssetBrowserViewMode,
} from '../../utils/assetVirtualization';

interface AssetVirtualBrowserProps {
  total: number;
  viewMode: AssetBrowserViewMode;
  activeAssetId: string | null;
  resetKey: string;
  cacheRevision: number;
  getItem: (index: number) => AssetRef | undefined;
  getSemanticHit?: (index: number) => AssetSemanticSearchHit | undefined;
  isSelected: (assetId: string) => boolean;
  onActivateAsset: (asset: AssetRef, index: number, selectionModified: boolean) => void;
  onToggleSelection: (asset: AssetRef, index: number) => void;
  onRangeSelection: (index: number, additive: boolean, keyboardAnchorIndex?: number) => void;
  onRangeChange: (startIndex: number, endIndex: number) => void;
}

function previewStatusLabel(asset: AssetRef): string | null {
  const status = asset.metadata?.previewStatus;
  if (status === 'queued') return '预览排队';
  if (status === 'running') return '生成预览';
  if (status === 'retrying') return '等待重试';
  if (status === 'failed') return '预览失败';
  if (status === 'unsupported') return '不支持预览';
  return null;
}

function assetCardPreviewUrl(asset: AssetRef): string {
  const metadata = asset.metadata || {};
  if (asset.kind === 'image') {
    return String(metadata.thumbnailUrl || (asset.sourceUrl ? previewImageUrl(asset.sourceUrl, 480) : ''));
  }
  if (asset.kind === 'video') {
    return String(metadata.thumbnailUrl || metadata.firstFrameUrl || metadata.contactSheetUrl || '');
  }
  if (asset.kind === 'audio') return String(metadata.waveformUrl || '');
  if (asset.kind === 'model3d') return String(metadata.modelPreviewUrl || '');
  return '';
}

function AssetCardPreview({ asset }: { asset: AssetRef }) {
  if (asset.availability === 'missing' || asset.availability === 'corrupt') {
    return <div className="grid h-full place-items-center px-2 text-center text-xs font-semibold text-red-500">{asset.availability === 'missing' ? '源文件已丢失' : '素材已损坏'}</div>;
  }
  const previewUrl = assetCardPreviewUrl(asset);
  if (previewUrl) {
    return <img src={previewUrl} alt="" aria-hidden="true" className={`h-full w-full ${asset.kind === 'audio' ? 'object-contain' : 'object-cover'}`} loading="lazy" decoding="async" />;
  }
  const status = previewStatusLabel(asset);
  return <div className="grid h-full place-items-center px-2 text-center text-[10px] font-semibold opacity-55">{status || (asset.kind === 'text' ? '文本素材' : `${asset.kind.toUpperCase()} 暂无预览`)}</div>;
}

function AssetCard({
  asset,
  index,
  selected,
  focused,
  active,
  mode,
  semanticHit,
  onActivateAsset,
  onToggleSelection,
  onRangeSelection,
  onActivate,
  onNavigate,
}: {
  asset: AssetRef;
  index: number;
  selected: boolean;
  focused: boolean;
  active: boolean;
  mode: AssetBrowserViewMode;
  semanticHit?: AssetSemanticSearchHit;
  onActivateAsset: (asset: AssetRef, index: number, selectionModified: boolean) => void;
  onToggleSelection: (asset: AssetRef, index: number) => void;
  onRangeSelection: (index: number, additive: boolean, keyboardAnchorIndex?: number) => void;
  onActivate: (index: number) => void;
  onNavigate: (event: KeyboardEvent<HTMLButtonElement>, index: number) => void;
}) {
  const size = Number(asset.metadata?.size || 0);
  const status = previewStatusLabel(asset);
  const unavailable = asset.availability === 'missing' || asset.availability === 'corrupt';
  const semanticLabel = semanticHit
    ? `${semanticHit.metric === 'rrf' ? 'RRF' : semanticHit.metric === 'cosine' ? 'Cosine' : semanticHit.metric} ${semanticHit.score.toFixed(4)}`
    : '';
  const semanticSnippet = semanticHit?.evidence[0]?.snippet || '';
  const handleCardClick = (event: MouseEvent<HTMLButtonElement>) => {
    onActivate(index);
    onActivateAsset(asset, index, event.shiftKey || event.ctrlKey || event.metaKey);
    if (event.shiftKey) onRangeSelection(index, event.ctrlKey || event.metaKey);
    else if (event.ctrlKey || event.metaKey) onToggleSelection(asset, index);
  };
  const checkbox = <input
    type="checkbox"
    data-asset-selection-checkbox
    aria-label={`批量选择 ${asset.filename}`}
    checked={selected}
    readOnly
    onClick={(event) => {
      event.stopPropagation();
      onToggleSelection(asset, index);
    }}
    className="h-4 w-4 shrink-0 accent-[var(--accent-primary)]"
  />;
  if (mode === 'list') {
    return <div className={`flex h-full w-full items-center gap-2 overflow-hidden rounded border p-2 ${selected ? 'border-[var(--accent-primary)] ring-1 ring-[var(--accent-primary)]' : 'border-[var(--border-primary)]'}`}>
      {checkbox}
      <button
      type="button"
      data-asset-card
      data-asset-index={index}
      data-asset-id={asset.id}
      tabIndex={focused ? 0 : -1}
      aria-pressed={selected}
      aria-current={active ? 'true' : undefined}
      aria-label={`${asset.filename}，${asset.kind}，${asset.availability}`}
      className="flex h-full min-w-0 flex-1 items-center gap-3 overflow-hidden text-left"
      onClick={handleCardClick}
      onFocus={() => onActivate(index)}
      onKeyDown={(event) => onNavigate(event, index)}
    >
      <span className="h-14 w-20 shrink-0 overflow-hidden rounded bg-[var(--bg-secondary)]"><AssetCardPreview asset={asset} /></span>
      <span className="min-w-0 flex-1"><span className="block truncate text-xs font-semibold">{asset.filename}</span><span className="mt-1 block truncate text-[10px] opacity-55">{asset.kind} · {size ? `${(size / 1024 / 1024).toFixed(1)} MB` : '—'} · {asset.storageMode}</span>{semanticHit && <span className="mt-1 block truncate text-[10px] text-[var(--accent-primary)]" title={semanticSnippet || semanticLabel}>{semanticLabel}{semanticSnippet ? ` · ${semanticSnippet}` : ''}</span>}</span>
      <span className={`shrink-0 text-[10px] font-bold ${unavailable || asset.metadata?.previewStatus === 'failed' ? 'text-red-500' : 'opacity-55'}`}>{status || asset.availability}</span>
      </button>
    </div>;
  }

  return <div className={`relative h-full w-full overflow-hidden rounded border ${selected ? 'border-[var(--accent-primary)] ring-1 ring-[var(--accent-primary)]' : 'border-[var(--border-primary)]'}`}>
    <span className="absolute left-2 top-2 z-10 grid rounded bg-black/55 p-1" onClick={(event) => event.stopPropagation()}>{checkbox}</span>
    <button
    type="button"
    data-asset-card
    data-asset-index={index}
    data-asset-id={asset.id}
    tabIndex={focused ? 0 : -1}
    aria-pressed={selected}
    aria-current={active ? 'true' : undefined}
    aria-label={`${asset.filename}，${asset.kind}，${asset.availability}`}
    className="h-full w-full overflow-hidden text-left"
    onClick={handleCardClick}
    onFocus={() => onActivate(index)}
    onKeyDown={(event) => onNavigate(event, index)}
  >
    <span className="relative block h-28 bg-[var(--bg-secondary)]"><AssetCardPreview asset={asset} />{status && <span className={`absolute right-1 top-1 rounded bg-black/70 px-1.5 py-0.5 text-[8px] font-bold text-white ${asset.metadata?.previewStatus === 'failed' ? 'ring-1 ring-red-500' : ''}`}>{status}</span>}</span>
    <span className="block p-2"><span className="block truncate text-xs font-semibold">{asset.filename}</span>{semanticHit ? <><span className="mt-1 block truncate text-[10px] font-semibold text-[var(--accent-primary)]">#{semanticHit.rank} · {semanticLabel}</span><span className="mt-1 block truncate text-[10px] opacity-60" title={semanticSnippet}>{semanticSnippet || `${asset.kind} · ${asset.storageMode}`}</span></> : <><span className="mt-1 block text-[10px] opacity-55">{asset.kind} · {size ? `${(size / 1024 / 1024).toFixed(1)} MB` : '—'}</span><span className={`mt-1 block truncate text-[10px] font-bold ${unavailable ? 'text-red-500' : 'opacity-55'}`}>{asset.storageMode} · {asset.availability}</span></>}</span>
    </button>
  </div>;
}

export default function AssetVirtualBrowser(props: AssetVirtualBrowserProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const previousLayoutRef = useRef<{ columns: number; rowPitch: number } | null>(null);
  const pendingFocusIndexRef = useRef<number | null>(null);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [scrollTop, setScrollTop] = useState(0);
  const [activeIndex, setActiveIndex] = useState(0);
  const [focusRequestToken, setFocusRequestToken] = useState(0);
  const layout = useMemo(() => calculateAssetVirtualWindow({
    itemCount: props.total,
    viewportWidth: viewport.width,
    viewportHeight: viewport.height,
    scrollTop,
    mode: props.viewMode,
  }), [props.total, props.viewMode, scrollTop, viewport.height, viewport.width]);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const previous = previousLayoutRef.current;
    if (previous && (previous.columns !== layout.columns || previous.rowPitch !== layout.rowPitch)) {
      const anchorIndex = assetScrollAnchorIndex(element.scrollTop, previous.columns, previous.rowPitch);
      const nextTop = assetIndexScrollTop(anchorIndex, layout.columns, layout.rowPitch);
      element.scrollTop = nextTop;
      setScrollTop(nextTop);
    }
    previousLayoutRef.current = { columns: layout.columns, rowPitch: layout.rowPitch };
  }, [layout.columns, layout.rowPitch]);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const measure = () => setViewport({ width: element.clientWidth, height: element.clientHeight });
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const element = scrollRef.current;
    if (element) element.scrollTop = 0;
    setScrollTop(0);
    setActiveIndex(0);
    pendingFocusIndexRef.current = null;
    setFocusRequestToken((token) => token + 1);
  }, [props.resetKey]);

  useEffect(() => {
    props.onRangeChange(layout.startIndex, layout.endIndex);
  }, [layout.endIndex, layout.startIndex, props.cacheRevision, props.onRangeChange]);

  useEffect(() => {
    const pending = pendingFocusIndexRef.current;
    if (pending == null || !props.getItem(pending)) return;
    const element = scrollRef.current?.querySelector<HTMLButtonElement>(`[data-asset-index="${pending}"]`);
    if (!element) return;
    pendingFocusIndexRef.current = null;
    element.focus();
  }, [activeIndex, focusRequestToken, layout.endIndex, layout.startIndex, props.cacheRevision, props.getItem]);

  const scrollToIndex = useCallback((index: number) => {
    const element = scrollRef.current;
    if (!element || props.total <= 0) return;
    const safeIndex = Math.max(0, Math.min(props.total - 1, index));
    const rowTop = assetIndexScrollTop(safeIndex, layout.columns, layout.rowPitch);
    const rowBottom = rowTop + layout.rowHeight;
    let nextTop = element.scrollTop;
    if (rowTop < element.scrollTop) nextTop = rowTop;
    else if (rowBottom > element.scrollTop + element.clientHeight) nextTop = Math.max(0, rowBottom - element.clientHeight);
    if (nextTop !== element.scrollTop) {
      element.scrollTop = nextTop;
      setScrollTop(nextTop);
    }
    setActiveIndex(safeIndex);
    pendingFocusIndexRef.current = safeIndex;
    setFocusRequestToken((token) => token + 1);
  }, [layout.columns, layout.rowHeight, layout.rowPitch, props.total]);

  const handleNavigate = useCallback((event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const current = props.getItem(index);
    if (event.key === ' ' && current) {
      event.preventDefault();
      props.onToggleSelection(current, index);
      return;
    }
    let next = index;
    const pageRows = Math.max(1, Math.floor(viewport.height / layout.rowPitch));
    if (event.key === 'ArrowRight') next += 1;
    else if (event.key === 'ArrowLeft') next -= 1;
    else if (event.key === 'ArrowDown') next += layout.columns;
    else if (event.key === 'ArrowUp') next -= layout.columns;
    else if (event.key === 'PageDown') next += pageRows * layout.columns;
    else if (event.key === 'PageUp') next -= pageRows * layout.columns;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = props.total - 1;
    else return;
    event.preventDefault();
    scrollToIndex(next);
    if (event.shiftKey) props.onRangeSelection(Math.max(0, Math.min(props.total - 1, next)), event.ctrlKey || event.metaKey, index);
  }, [layout.columns, layout.rowPitch, props, scrollToIndex, viewport.height]);

  const rows = useMemo(() => {
    if (layout.endRow < layout.startRow) return [] as number[];
    return Array.from({ length: layout.endRow - layout.startRow + 1 }, (_, offset) => layout.startRow + offset);
  }, [layout.endRow, layout.startRow]);

  return <div
    ref={scrollRef}
    data-asset-virtual-browser
    data-asset-view={props.viewMode}
    className="relative h-full min-h-0 overflow-auto overscroll-contain"
    role={props.viewMode === 'grid' ? 'grid' : 'listbox'}
    aria-label={props.viewMode === 'grid' ? '素材虚拟化网格' : '素材虚拟化列表'}
    aria-multiselectable="true"
    aria-rowcount={props.viewMode === 'grid' ? layout.rowCount : undefined}
    aria-colcount={props.viewMode === 'grid' ? layout.columns : undefined}
    aria-busy={props.total > 0 && !props.getItem(layout.startIndex)}
    onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
  >
    <div className="relative w-full" style={{ height: layout.totalHeight }}>
      {rows.map((row) => {
        const firstIndex = row * layout.columns;
        const indices = Array.from({ length: layout.columns }, (_, column) => firstIndex + column).filter((index) => index < props.total);
        return <div
          key={row}
          role={props.viewMode === 'grid' ? 'row' : 'presentation'}
          aria-rowindex={props.viewMode === 'grid' ? row + 1 : undefined}
          className="absolute left-0 right-0 grid"
          style={{
            height: layout.rowHeight,
            top: row * layout.rowPitch,
            gap: ASSET_VIRTUAL_GAP,
            gridTemplateColumns: `repeat(${layout.columns}, minmax(0, 1fr))`,
          }}
        >
          {indices.map((index) => {
            const asset = props.getItem(index);
            const wrapperRole = props.viewMode === 'grid' ? 'gridcell' : 'option';
            return <div
              key={asset?.id || `placeholder-${index}`}
              role={wrapperRole}
              aria-colindex={props.viewMode === 'grid' ? index % layout.columns + 1 : undefined}
              aria-selected={asset ? props.isSelected(asset.id) : undefined}
              aria-setsize={props.viewMode === 'list' ? props.total : undefined}
              aria-posinset={props.viewMode === 'list' ? index + 1 : undefined}
              className="min-h-0 min-w-0"
            >
              {asset ? <AssetCard asset={asset} index={index} selected={props.isSelected(asset.id)} focused={activeIndex === index} active={props.activeAssetId === asset.id} mode={props.viewMode} semanticHit={props.getSemanticHit?.(index)} onActivateAsset={props.onActivateAsset} onToggleSelection={props.onToggleSelection} onRangeSelection={props.onRangeSelection} onActivate={setActiveIndex} onNavigate={handleNavigate} /> : <div data-asset-placeholder aria-hidden="true" className="h-full animate-pulse rounded border border-[var(--border-primary)] bg-[var(--bg-secondary)]" />}
            </div>;
          })}
        </div>;
      })}
    </div>
  </div>;
}
