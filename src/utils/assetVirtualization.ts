export type AssetBrowserViewMode = 'grid' | 'list';

export const ASSET_PAGE_SIZE = 120;
export const ASSET_PAGE_CACHE_LIMIT = 8;
export const ASSET_PAGE_REQUEST_LIMIT = 6;
export const ASSET_VIRTUAL_OVERSCAN_ROWS = 3;
export const ASSET_VIRTUAL_GAP = 8;
export const ASSET_GRID_MIN_COLUMN_WIDTH = 168;
export const ASSET_GRID_ROW_HEIGHT = 196;
export const ASSET_LIST_ROW_HEIGHT = 82;

export interface AssetVirtualWindowInput {
  itemCount: number;
  viewportWidth: number;
  viewportHeight: number;
  scrollTop: number;
  mode: AssetBrowserViewMode;
  overscanRows?: number;
  gap?: number;
  gridMinColumnWidth?: number;
  gridRowHeight?: number;
  listRowHeight?: number;
}

export interface AssetVirtualWindow {
  columns: number;
  rowHeight: number;
  rowPitch: number;
  rowCount: number;
  totalHeight: number;
  startRow: number;
  endRow: number;
  startIndex: number;
  endIndex: number;
  renderedItemLimit: number;
}

function finiteNonNegative(value: number, fallback = 0): number {
  return Number.isFinite(value) ? Math.max(0, value) : fallback;
}

export function calculateAssetVirtualWindow(input: AssetVirtualWindowInput): AssetVirtualWindow {
  const itemCount = Math.max(0, Math.trunc(finiteNonNegative(input.itemCount)));
  const viewportWidth = finiteNonNegative(input.viewportWidth);
  const viewportHeight = finiteNonNegative(input.viewportHeight);
  const gap = finiteNonNegative(input.gap ?? ASSET_VIRTUAL_GAP);
  const overscanRows = Math.max(0, Math.trunc(finiteNonNegative(input.overscanRows ?? ASSET_VIRTUAL_OVERSCAN_ROWS)));
  const gridMinColumnWidth = Math.max(1, finiteNonNegative(input.gridMinColumnWidth ?? ASSET_GRID_MIN_COLUMN_WIDTH, ASSET_GRID_MIN_COLUMN_WIDTH));
  const columns = input.mode === 'list'
    ? 1
    : Math.max(1, Math.floor((viewportWidth + gap) / (gridMinColumnWidth + gap)));
  const rowHeight = Math.max(1, input.mode === 'list'
    ? finiteNonNegative(input.listRowHeight ?? ASSET_LIST_ROW_HEIGHT, ASSET_LIST_ROW_HEIGHT)
    : finiteNonNegative(input.gridRowHeight ?? ASSET_GRID_ROW_HEIGHT, ASSET_GRID_ROW_HEIGHT));
  const rowPitch = rowHeight + gap;
  const rowCount = columns > 0 ? Math.ceil(itemCount / columns) : 0;
  const totalHeight = rowCount > 0 ? rowCount * rowPitch - gap : 0;
  if (!rowCount) {
    return {
      columns,
      rowHeight,
      rowPitch,
      rowCount: 0,
      totalHeight: 0,
      startRow: 0,
      endRow: -1,
      startIndex: 0,
      endIndex: 0,
      renderedItemLimit: 0,
    };
  }

  const maxScrollTop = Math.max(0, totalHeight - viewportHeight);
  const scrollTop = Math.min(finiteNonNegative(input.scrollTop), maxScrollTop);
  const firstVisibleRow = Math.min(rowCount - 1, Math.floor(scrollTop / rowPitch));
  const lastVisibleRow = Math.min(
    rowCount - 1,
    Math.max(firstVisibleRow, Math.floor((scrollTop + Math.max(0, viewportHeight - 1)) / rowPitch)),
  );
  const startRow = Math.max(0, firstVisibleRow - overscanRows);
  const endRow = Math.min(rowCount - 1, lastVisibleRow + overscanRows);
  const startIndex = startRow * columns;
  const endIndex = Math.min(itemCount, (endRow + 1) * columns);

  return {
    columns,
    rowHeight,
    rowPitch,
    rowCount,
    totalHeight,
    startRow,
    endRow,
    startIndex,
    endIndex,
    renderedItemLimit: Math.max(0, endRow - startRow + 1) * columns,
  };
}

export function assetPageOffset(index: number, pageSize = ASSET_PAGE_SIZE): number {
  const safePageSize = Math.max(1, Math.trunc(finiteNonNegative(pageSize, ASSET_PAGE_SIZE)));
  const safeIndex = Math.max(0, Math.trunc(finiteNonNegative(index)));
  return Math.floor(safeIndex / safePageSize) * safePageSize;
}

export function assetPageOffsetsForRange(
  startIndex: number,
  endIndex: number,
  pageSize = ASSET_PAGE_SIZE,
): number[] {
  const safePageSize = Math.max(1, Math.trunc(finiteNonNegative(pageSize, ASSET_PAGE_SIZE)));
  const start = Math.max(0, Math.trunc(finiteNonNegative(startIndex)));
  const end = Math.max(start, Math.trunc(finiteNonNegative(endIndex)));
  if (end <= start) return [];
  const first = assetPageOffset(start, safePageSize);
  const last = assetPageOffset(end - 1, safePageSize);
  const offsets: number[] = [];
  for (let offset = first; offset <= last; offset += safePageSize) offsets.push(offset);
  return offsets;
}

export function updateAssetPageLru<T>(
  current: ReadonlyMap<number, readonly T[]>,
  offset: number,
  items: readonly T[],
  maxPages = ASSET_PAGE_CACHE_LIMIT,
): Map<number, readonly T[]> {
  const next = new Map(current);
  const safeOffset = Math.max(0, Math.trunc(finiteNonNegative(offset)));
  if (next.has(safeOffset)) next.delete(safeOffset);
  next.set(safeOffset, [...items]);
  const safeMaxPages = Math.max(1, Math.trunc(finiteNonNegative(maxPages, ASSET_PAGE_CACHE_LIMIT)));
  while (next.size > safeMaxPages) {
    const oldest = next.keys().next().value;
    if (oldest === undefined) break;
    next.delete(oldest);
  }
  return next;
}

export function readAssetPageItem<T>(
  pages: ReadonlyMap<number, readonly T[]>,
  index: number,
  pageSize = ASSET_PAGE_SIZE,
): T | undefined {
  const safeIndex = Math.max(0, Math.trunc(finiteNonNegative(index)));
  const offset = assetPageOffset(safeIndex, pageSize);
  return pages.get(offset)?.[safeIndex - offset];
}

export function assetIndexScrollTop(index: number, columns: number, rowPitch: number): number {
  const safeIndex = Math.max(0, Math.trunc(finiteNonNegative(index)));
  const safeColumns = Math.max(1, Math.trunc(finiteNonNegative(columns, 1)));
  const safePitch = Math.max(1, finiteNonNegative(rowPitch, 1));
  return Math.floor(safeIndex / safeColumns) * safePitch;
}

export function assetScrollAnchorIndex(scrollTop: number, columns: number, rowPitch: number): number {
  const safeColumns = Math.max(1, Math.trunc(finiteNonNegative(columns, 1)));
  const safePitch = Math.max(1, finiteNonNegative(rowPitch, 1));
  return Math.floor(finiteNonNegative(scrollTop) / safePitch) * safeColumns;
}
