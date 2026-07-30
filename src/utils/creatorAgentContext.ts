export interface CreatorCanvasNodeLike {
  id: string;
  type?: string | null;
  selected?: boolean;
  position?: { x?: number; y?: number };
  positionAbsolute?: { x?: number; y?: number };
  width?: number | null;
  height?: number | null;
  measured?: { width?: number; height?: number };
  data?: unknown;
}

export interface CreatorCanvasEdgeLike {
  source?: string | null;
  target?: string | null;
}

export interface CreatorCanvasViewport {
  x: number;
  y: number;
  zoom: number;
}

export interface CreatorCanvasObjectSummary {
  nodeId: string;
  nodeType: string;
  label: string;
  status: string;
  selected: boolean;
  inViewport: boolean;
  mediaKinds: Array<'image' | 'video' | 'audio' | 'text' | 'model3d'>;
  resultCount: number;
  accepted: boolean;
  lockKeys: string[];
  upstreamCount: number;
  downstreamCount: number;
}

export interface CreatorCanvasOffscreenSummary {
  nodeCount: number;
  failedCount: number;
  outputCount: number;
  lockedCount: number;
}

const ACTIVE_STATUSES = new Set([
  'queued',
  'accepted',
  'dispatching',
  'submitting',
  'running',
  'generating',
  'polling',
  'streaming',
  'downloading',
]);
const FAILED_STATUSES = new Set(['failed', 'error', 'stopped', 'interrupted', 'cancelled']);
const COMPLETED_STATUSES = new Set(['success', 'succeeded', 'completed', 'done']);

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function boundedLabel(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const clean = value.replace(/\s+/g, ' ').trim();
  return clean ? clean.slice(0, 120) : fallback;
}

function normalizeStatus(data: Record<string, unknown>): string {
  const raw = [data.status, data.runStatus, data.lastRunStatus]
    .find((value) => typeof value === 'string' && value.trim());
  const clean = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (FAILED_STATUSES.has(clean)) return 'failed';
  if (ACTIVE_STATUSES.has(clean)) return 'running';
  if (COMPLETED_STATUSES.has(clean)) return 'completed';
  return 'idle';
}

function collectMedia(data: Record<string, unknown>) {
  const values = new Map<string, Set<string>>();
  const collect = (kind: string, value: unknown) => {
    if (!values.has(kind)) values.set(kind, new Set());
    const bucket = values.get(kind)!;
    const push = (entry: unknown) => {
      if (typeof entry === 'string' && entry.trim()) bucket.add(entry.trim());
    };
    if (Array.isArray(value)) value.forEach(push);
    else push(value);
  };
  collect('image', data.imageUrl);
  collect('image', data.imageUrls);
  collect('image', data.generatedImages);
  collect('video', data.videoUrl);
  collect('video', data.videoUrls);
  collect('audio', data.audioUrl);
  collect('audio', data.audioUrls);
  collect('model3d', data.modelUrl);
  collect('model3d', data.modelUrls);
  collect('text', data.outputText);
  collect('text', data.reply);
  const mediaKinds = [...values.entries()]
    .filter(([, entries]) => entries.size > 0)
    .map(([kind]) => kind as CreatorCanvasObjectSummary['mediaKinds'][number]);
  const resultCount = [...values.values()].reduce((total, entries) => total + entries.size, 0);
  return { mediaKinds, resultCount };
}

function collectLocks(data: Record<string, unknown>): string[] {
  const locks = new Set<string>();
  if (data.locked === true || data.isLocked === true) locks.add('object');
  const lockMap = record(data.locks);
  Object.entries(lockMap).forEach(([key, value]) => {
    if (value === true) locks.add(boundedLabel(key, 'locked'));
  });
  for (const key of ['lockedFields', 'lockedDimensions']) {
    const values = data[key];
    if (!Array.isArray(values)) continue;
    values.forEach((value) => {
      if (typeof value === 'string' && value.trim()) locks.add(value.trim().slice(0, 48));
    });
  }
  return [...locks].slice(0, 8);
}

function intersectsViewport(
  node: CreatorCanvasNodeLike,
  viewport: CreatorCanvasViewport,
  viewportSize: { width: number; height: number },
): boolean {
  const zoom = Number.isFinite(viewport.zoom) && viewport.zoom > 0 ? viewport.zoom : 1;
  const position = node.positionAbsolute || node.position || {};
  const x = Number(position.x) || 0;
  const y = Number(position.y) || 0;
  const width = Math.max(1, Number(node.measured?.width ?? node.width) || 320);
  const height = Math.max(1, Number(node.measured?.height ?? node.height) || 220);
  const left = x * zoom + (Number(viewport.x) || 0);
  const top = y * zoom + (Number(viewport.y) || 0);
  const right = left + width * zoom;
  const bottom = top + height * zoom;
  const margin = 64;
  return right >= -margin
    && bottom >= -margin
    && left <= Math.max(1, Number(viewportSize.width) || 1) + margin
    && top <= Math.max(1, Number(viewportSize.height) || 1) + margin;
}

export function buildCreatorCanvasContext(
  nodes: CreatorCanvasNodeLike[],
  edges: CreatorCanvasEdgeLike[],
  viewport: CreatorCanvasViewport,
  viewportSize: { width: number; height: number },
): {
  objects: CreatorCanvasObjectSummary[];
  offscreenSummary: CreatorCanvasOffscreenSummary;
} {
  const upstreamCounts = new Map<string, Set<string>>();
  const downstreamCounts = new Map<string, Set<string>>();
  for (const edge of Array.isArray(edges) ? edges : []) {
    const source = typeof edge?.source === 'string' ? edge.source : '';
    const target = typeof edge?.target === 'string' ? edge.target : '';
    if (!source || !target) continue;
    if (!upstreamCounts.has(target)) upstreamCounts.set(target, new Set());
    if (!downstreamCounts.has(source)) downstreamCounts.set(source, new Set());
    upstreamCounts.get(target)!.add(source);
    downstreamCounts.get(source)!.add(target);
  }

  const summaries = (Array.isArray(nodes) ? nodes : []).map((node, index) => {
    const data = record(node.data);
    const nodeType = boundedLabel(node.type, 'unknown');
    const label = boundedLabel(
      data.storyTitle
        || data.title
        || data.name
        || data.label
        || data.toolTitle,
      nodeType,
    );
    const status = normalizeStatus(data);
    const { mediaKinds, resultCount } = collectMedia(data);
    const lockKeys = collectLocks(data);
    const accepted = data.accepted === true
      || data.isAccepted === true
      || (typeof data.acceptedCandidateId === 'string' && Boolean(data.acceptedCandidateId.trim()))
      || (typeof data.acceptedVersionId === 'string' && Boolean(data.acceptedVersionId.trim()));
    return {
      index,
      nodeId: boundedLabel(node.id, `node-${index + 1}`),
      nodeType,
      label,
      status,
      selected: node.selected === true,
      inViewport: intersectsViewport(node, viewport, viewportSize),
      mediaKinds,
      resultCount,
      accepted,
      lockKeys,
      upstreamCount: upstreamCounts.get(node.id)?.size || 0,
      downstreamCount: downstreamCounts.get(node.id)?.size || 0,
    };
  });

  const offscreen = summaries.filter((item) => !item.inViewport);
  const priority = (item: typeof summaries[number]) => {
    if (item.selected) return 0;
    if (item.status === 'failed') return 1;
    if (item.status === 'running') return 2;
    if (item.inViewport) return 3;
    if (item.resultCount > 0 || item.accepted || item.lockKeys.length > 0) return 4;
    return 5;
  };
  const objects = summaries
    .sort((left, right) => priority(left) - priority(right) || left.index - right.index)
    .slice(0, 24)
    .map(({ index: _index, ...item }) => item);

  return {
    objects,
    offscreenSummary: {
      nodeCount: offscreen.length,
      failedCount: offscreen.filter((item) => item.status === 'failed').length,
      outputCount: offscreen.reduce((total, item) => total + item.resultCount, 0),
      lockedCount: offscreen.filter((item) => item.accepted || item.lockKeys.length > 0).length,
    },
  };
}
