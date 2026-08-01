const NODE_ACTION_BAR_GAP = 8;

export function resolveNodeActionBarGeometry({
  nodeX,
  nodeY,
  nodeWidth,
  viewportX,
  viewportY,
  zoom,
}: {
  nodeX: number;
  nodeY: number;
  nodeWidth: number;
  viewportX: number;
  viewportY: number;
  zoom: number;
}) {
  const safeZoom = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  return {
    anchorX: nodeX * safeZoom + viewportX + nodeWidth * safeZoom,
    anchorY: nodeY * safeZoom + viewportY - NODE_ACTION_BAR_GAP * safeZoom,
    scale: safeZoom,
  };
}
