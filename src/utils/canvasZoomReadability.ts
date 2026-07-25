export type CanvasZoomReadabilityTier = 'detail' | 'compact' | 'overview';

const COMPACT_ZOOM_THRESHOLD = 0.9;
const OVERVIEW_ZOOM_THRESHOLD = 0.45;

export function resolveCanvasZoomReadabilityTier(zoom: number): CanvasZoomReadabilityTier {
  const safeZoom = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  if (safeZoom < OVERVIEW_ZOOM_THRESHOLD) return 'overview';
  if (safeZoom < COMPACT_ZOOM_THRESHOLD) return 'compact';
  return 'detail';
}

export function snapCanvasViewportToDevicePixels<T extends { x: number; y: number; zoom: number }>(
  viewport: T,
  devicePixelRatio: number,
): T {
  const safeRatio = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0
    ? devicePixelRatio
    : 1;
  return {
    ...viewport,
    x: Math.round(viewport.x * safeRatio) / safeRatio,
    y: Math.round(viewport.y * safeRatio) / safeRatio,
  };
}
