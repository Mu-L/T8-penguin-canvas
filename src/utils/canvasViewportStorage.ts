import type { Viewport } from '@xyflow/react';

export const CANVAS_VIEWPORT_STORAGE_KEY = 't8-canvas-viewport-v1';
export const CANVAS_VIEWPORT_STORAGE_LIMIT = 100;
export const CANVAS_VIEWPORT_MIN_ZOOM = 0.02;
export const CANVAS_VIEWPORT_MAX_ZOOM = 4;
const CANVAS_VIEWPORT_MAX_ABSOLUTE_OFFSET = 10_000_000;

export interface CanvasViewportStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

interface StoredCanvasViewportEntry {
  canvasId: string;
  viewport: Viewport;
  updatedAt: number;
}

interface StoredCanvasViewportState {
  version: 1;
  entries: StoredCanvasViewportEntry[];
}

function validCanvasId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 240;
}

export function validCanvasViewport(value: unknown): Viewport | null {
  if (!value || typeof value !== 'object') return null;
  const viewport = value as Partial<Viewport>;
  if (
    typeof viewport.x !== 'number'
    || !Number.isFinite(viewport.x)
    || Math.abs(viewport.x) > CANVAS_VIEWPORT_MAX_ABSOLUTE_OFFSET
    || typeof viewport.y !== 'number'
    || !Number.isFinite(viewport.y)
    || Math.abs(viewport.y) > CANVAS_VIEWPORT_MAX_ABSOLUTE_OFFSET
    || typeof viewport.zoom !== 'number'
    || !Number.isFinite(viewport.zoom)
    || viewport.zoom < CANVAS_VIEWPORT_MIN_ZOOM
    || viewport.zoom > CANVAS_VIEWPORT_MAX_ZOOM
  ) {
    return null;
  }
  return { x: viewport.x, y: viewport.y, zoom: viewport.zoom };
}

export interface PendingCanvasViewportWrite {
  canvasId: string;
  viewport: Viewport;
}

export function stageCanvasViewportWrite(
  current: PendingCanvasViewportWrite | null,
  canvasId: string,
  value: unknown,
): { pending: PendingCanvasViewportWrite; displaced: PendingCanvasViewportWrite | null } | null {
  if (!validCanvasId(canvasId)) return null;
  const viewport = validCanvasViewport(value);
  if (!viewport) return null;
  return {
    pending: { canvasId, viewport },
    displaced: current && current.canvasId !== canvasId ? current : null,
  };
}

export function isDefaultCanvasViewport(viewport: Viewport): boolean {
  return Math.abs(viewport.x) < 0.001
    && Math.abs(viewport.y) < 0.001
    && Math.abs(viewport.zoom - 1) < 0.0001;
}

function parseStoredCanvasViewports(raw: string | null): StoredCanvasViewportEntry[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as Partial<StoredCanvasViewportState>;
    if (parsed.version !== 1 || !Array.isArray(parsed.entries)) return [];
    const seen = new Set<string>();
    const entries: StoredCanvasViewportEntry[] = [];
    for (const candidate of parsed.entries) {
      if (!candidate || typeof candidate !== 'object') continue;
      const entry = candidate as Partial<StoredCanvasViewportEntry>;
      if (!validCanvasId(entry.canvasId) || seen.has(entry.canvasId)) continue;
      const viewport = validCanvasViewport(entry.viewport);
      if (!viewport) continue;
      const updatedAt = typeof entry.updatedAt === 'number' && Number.isFinite(entry.updatedAt)
        ? Math.max(0, entry.updatedAt)
        : 0;
      seen.add(entry.canvasId);
      entries.push({ canvasId: entry.canvasId, viewport, updatedAt });
    }
    return entries
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, CANVAS_VIEWPORT_STORAGE_LIMIT);
  } catch {
    return [];
  }
}

export function readCanvasViewport(
  storage: CanvasViewportStorage | null | undefined,
  canvasId: string,
): Viewport | null {
  if (!storage || !validCanvasId(canvasId)) return null;
  try {
    return parseStoredCanvasViewports(storage.getItem(CANVAS_VIEWPORT_STORAGE_KEY))
      .find((entry) => entry.canvasId === canvasId)?.viewport || null;
  } catch {
    return null;
  }
}

export function writeCanvasViewport(
  storage: CanvasViewportStorage | null | undefined,
  canvasId: string,
  value: unknown,
  updatedAt = Date.now(),
): boolean {
  if (!storage || !validCanvasId(canvasId)) return false;
  const viewport = validCanvasViewport(value);
  if (!viewport) return false;
  try {
    const entries = parseStoredCanvasViewports(storage.getItem(CANVAS_VIEWPORT_STORAGE_KEY));
    const next: StoredCanvasViewportState = {
      version: 1,
      entries: [
        {
          canvasId,
          viewport,
          updatedAt: Number.isFinite(updatedAt) ? Math.max(0, updatedAt) : Date.now(),
        },
        ...entries.filter((entry) => entry.canvasId !== canvasId),
      ].slice(0, CANVAS_VIEWPORT_STORAGE_LIMIT),
    };
    storage.setItem(CANVAS_VIEWPORT_STORAGE_KEY, JSON.stringify(next));
    return true;
  } catch {
    return false;
  }
}

export function resolveCanvasInitialViewport(
  storage: CanvasViewportStorage | null | undefined,
  canvasId: string,
  backendViewport: unknown,
): Viewport | null {
  const localViewport = readCanvasViewport(storage, canvasId);
  if (localViewport) return localViewport;
  const savedViewport = validCanvasViewport(backendViewport);
  // Legacy canvases were created with this placeholder even when their content
  // lived elsewhere. Without a newer local value it is ambiguous, so fit once.
  if (!savedViewport || isDefaultCanvasViewport(savedViewport)) return null;
  return savedViewport;
}

export function getBrowserCanvasViewportStorage(): CanvasViewportStorage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
