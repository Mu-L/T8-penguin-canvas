import type { SubflowDefinition } from './subflows';

const MAX_FAVORITES = 1000;
const MAX_TAGS = 30;
const MAX_LABEL_LENGTH = 60;

export interface SubflowThumbnailItem {
  id: string;
  label: string;
  leftPercent: number;
  topPercent: number;
}

export interface SubflowThumbnailLayout {
  nodes: SubflowThumbnailItem[];
  totalNodes: number;
  totalEdges: number;
}

function finiteCoordinate(value: unknown) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function cleanLibraryText(value: unknown, maxLength = MAX_LABEL_LENGTH) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function cloneDefinitionContent<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function buildSubflowThumbnailLayout(definition: SubflowDefinition, maxNodes = 24): SubflowThumbnailLayout {
  const nodes = (definition.nodes || []).slice(0, Math.max(0, Math.trunc(maxNodes) || 0));
  const points = nodes.map((node) => ({
    node,
    x: finiteCoordinate(node.position?.x),
    y: finiteCoordinate(node.position?.y),
  }));
  const xs = points.map((item) => item.x);
  const ys = points.map((item) => item.y);
  const minX = xs.length > 0 ? Math.min(...xs) : 0;
  const minY = ys.length > 0 ? Math.min(...ys) : 0;
  const maxX = xs.length > 0 ? Math.max(...xs) : minX;
  const maxY = ys.length > 0 ? Math.max(...ys) : minY;
  const width = Math.max(1, maxX - minX);
  const height = Math.max(1, maxY - minY);
  return {
    nodes: points.map(({ node, x, y }) => ({
      id: String(node.id),
      label: cleanLibraryText((node.data as Record<string, unknown> | undefined)?.label || node.type || node.id, 120),
      leftPercent: Math.min(80, Math.max(8, 8 + ((x - minX) / width) * 72)),
      topPercent: Math.min(75, Math.max(10, 10 + ((y - minY) / height) * 65)),
    })),
    totalNodes: definition.nodes?.length || 0,
    totalEdges: definition.edges?.length || 0,
  };
}

export function parseSubflowFavoriteIds(serialized: string | null | undefined) {
  try {
    const parsed = JSON.parse(serialized || '[]');
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.map((item) => cleanLibraryText(item, 200)).filter(Boolean))].slice(0, MAX_FAVORITES);
  } catch (_) {
    return [];
  }
}

export function toggleSubflowFavorite(ids: string[], definitionId: string) {
  const cleanId = cleanLibraryText(definitionId, 200);
  const current = [...new Set((ids || []).map((item) => cleanLibraryText(item, 200)).filter(Boolean))];
  if (!cleanId) return current.slice(0, MAX_FAVORITES);
  return current.includes(cleanId)
    ? current.filter((id) => id !== cleanId)
    : [...current, cleanId].slice(0, MAX_FAVORITES);
}

export function normalizeSubflowLibraryMetadata(category: unknown, tags: unknown) {
  const values = Array.isArray(tags) ? tags : String(tags ?? '').split(/[,，\n]/);
  return {
    category: cleanLibraryText(category),
    tags: [...new Set(values.map((tag) => cleanLibraryText(tag)).filter(Boolean))].slice(0, MAX_TAGS),
  };
}

export function createIndependentSubflowDraft(
  definition: SubflowDefinition,
  options: { id: string; projectId?: string; name?: string },
) {
  const {
    entityUid: _entityUid,
    version: _version,
    revision: _revision,
    changeSummary: _changeSummary,
    publishedBy: _publishedBy,
    publishedAt: _publishedAt,
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    ...content
  } = cloneDefinitionContent(definition);
  const id = cleanLibraryText(options.id, 200);
  if (!id) throw new Error('独立副本 ID 不能为空');
  const sourceName = cleanLibraryText(definition.name, 100) || '未命名子工作流';
  return {
    ...content,
    id,
    projectId: cleanLibraryText(options.projectId || definition.projectId || 'project-local', 200) || 'project-local',
    name: cleanLibraryText(options.name || `${sourceName} 副本`, 100) || `${sourceName} 副本`,
    baseRevision: 0,
    changeSummary: `从 ${sourceName} v${definition.version} 另存独立副本`,
  };
}
