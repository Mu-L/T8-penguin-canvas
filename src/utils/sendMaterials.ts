import type { Node } from '@xyflow/react';
import type { ResourceItem, ResourceMaterialSetKind } from '../services/api';
import { collectMaterialSetBucketsFromData, normalizeMaterialSetItems, type MaterialSetItem, type MaterialSetKind } from './materialSet';
import { fileNameFromUrl, type MediaItem, type MediaKind } from './mediaCollection';
import { shouldCollectNodeTextOutput } from './imageNodeOutputMode';

export type SendTargetMode =
  | 'auto'
  | 'node-fragment'
  | 'material-set'
  | 'upload'
  | 'split-upload'
  | 'output'
  | 'portrait-master'
  | 'video-edit';

export interface SendableMaterial extends MaterialSetItem {
  sourceNodeId?: string;
  sourceCanvasId?: string;
  sourceType?: string;
  sourceNodeData?: Record<string, any>;
}

export type SendableBuckets = Record<MaterialSetKind, SendableMaterial[]>;

const MATERIAL_KINDS: MaterialSetKind[] = ['text', 'image', 'video', 'audio'];
type SendMediaKind = Exclude<MediaKind, 'model3d'>;

function isSendMediaKind(value: any): value is SendMediaKind {
  return value === 'image' || value === 'video' || value === 'audio';
}

function toSendable(item: MaterialSetItem, meta: Partial<SendableMaterial> = {}): SendableMaterial {
  return {
    ...item,
    name: item.name || (item.kind === 'text' ? (item.text || '').slice(0, 24) : fileNameFromUrl(item.url || '')),
    ...meta,
  };
}

function cloneNodeData(data: unknown): Record<string, any> | undefined {
  if (!data || typeof data !== 'object') return undefined;
  try {
    return JSON.parse(JSON.stringify(data));
  } catch {
    return { ...(data as Record<string, any>) };
  }
}

function pushUnique(bucket: SendableMaterial[], seen: Set<string>, item: SendableMaterial) {
  const value = item.kind === 'text' ? item.text : item.url;
  if (!value) return;
  const key = `${item.kind}:${value}`;
  if (seen.has(key)) return;
  seen.add(key);
  bucket.push(item);
}

export function emptySendableBuckets(): SendableBuckets {
  return { text: [], image: [], video: [], audio: [] };
}

export function bucketSendableMaterials(materials: SendableMaterial[]): SendableBuckets {
  const buckets = emptySendableBuckets();
  const seen = new Set<string>();
  for (const item of materials) {
    if (!MATERIAL_KINDS.includes(item.kind)) continue;
    pushUnique(buckets[item.kind], seen, item);
  }
  return buckets;
}

export function sendableMaterialKey(item: Pick<SendableMaterial, 'kind' | 'text' | 'url'>): string {
  const value = item.kind === 'text' ? (item.text || '').trim() : (item.url || '').trim();
  return value ? `${item.kind}:${value}` : '';
}

export function sendableMaterialSignature(materials: SendableMaterial[]): string {
  const keys = new Set<string>();
  const buckets = bucketSendableMaterials(materials);
  for (const kind of MATERIAL_KINDS) {
    for (const item of buckets[kind]) {
      const key = sendableMaterialKey(item);
      if (key) keys.add(key);
    }
  }
  return [...keys].sort().join('|');
}

export function collectSendableMaterialsFromNode(node: Node, sourceCanvasId?: string | null): SendableMaterial[] {
  const buckets = collectMaterialSetBucketsFromData(node.data);
  const out: SendableMaterial[] = [];
  const sourceType = String(node.type || '');
  const meta: Partial<SendableMaterial> = {
    sourceNodeId: node.id,
    sourceCanvasId: sourceCanvasId || undefined,
    sourceType,
    sourceNodeData: cloneNodeData(node.data),
  };
  for (const kind of MATERIAL_KINDS) {
    if (kind === 'text' && !shouldCollectNodeTextOutput(node.type, node.data)) continue;
    for (const item of buckets[kind]) {
      out.push(toSendable(item, meta));
    }
  }
  if (sourceType === 'portrait-master' && !out.some((item) => item.kind === 'text')) {
    const data = (node.data || {}) as Record<string, any>;
    const text =
      String(data.prompt || data.outputText || data.text || data.portraitSummary || '').trim() ||
      '肖像大师配置';
    out.push(
      toSendable(
        {
          id: `portrait-master-${node.id}`,
          kind: 'text',
          text,
          name: '肖像大师配置',
        },
        meta,
      ),
    );
  }
  return out;
}

export function collectSendableMaterialsFromNodes(
  nodes: Node[],
  sourceCanvasId?: string | null,
): SendableMaterial[] {
  return [...nodes]
    .filter((node) => node.type !== 'groupBox')
    .sort((a, b) => {
      const dy = (a.position?.y ?? 0) - (b.position?.y ?? 0);
      if (Math.abs(dy) > 24) return dy;
      return (a.position?.x ?? 0) - (b.position?.x ?? 0);
    })
    .flatMap((node) => collectSendableMaterialsFromNode(node, sourceCanvasId));
}

export function resourceItemToSendMaterials(item: ResourceItem): SendableMaterial[] {
  if (item.kind === 'set') {
    const kind = item.materialSetKind as ResourceMaterialSetKind | undefined;
    if (!kind || !MATERIAL_KINDS.includes(kind as MaterialSetKind)) return [];
    return normalizeMaterialSetItems(item.materialSetItems || [], kind as MaterialSetKind).map((child) =>
      toSendable(child, {
        sourceNodeId: item.sourceNodeId,
        sourceCanvasId: item.sourceCanvasId,
        sourceType: 'resource-set',
      }),
    );
  }
  const mediaKind = item.kind === 'panorama' ? 'image' : item.kind;
  if (!isSendMediaKind(mediaKind) || !item.fileUrl) return [];
  return [
    toSendable(
      {
        id: item.id,
        kind: mediaKind,
        url: item.fileUrl,
        // 资源接口 URL 没有扩展名；优先保留原文件名，供下游上传识别真实格式。
        name: item.originalName || item.title || fileNameFromUrl(item.fileUrl),
        size: item.size,
        mime: item.mime,
      },
      {
        sourceNodeId: item.sourceNodeId,
        sourceCanvasId: item.sourceCanvasId,
        sourceType: 'resource-item',
      },
    ),
  ];
}

export function sendableToMediaItem(item: SendableMaterial): MediaItem | null {
  if (!isSendMediaKind(item.kind) || !item.url) return null;
  return {
    kind: item.kind,
    url: item.url,
    name: item.name || fileNameFromUrl(item.url),
    size: item.size,
    mime: item.mime,
  };
}

export function summarizeSendableMaterials(materials: SendableMaterial[]): string {
  const buckets = bucketSendableMaterials(materials);
  const parts: string[] = [];
  if (buckets.image.length) parts.push(`${buckets.image.length} 图像`);
  if (buckets.video.length) parts.push(`${buckets.video.length} 视频`);
  if (buckets.audio.length) parts.push(`${buckets.audio.length} 音频`);
  if (buckets.text.length) parts.push(`${buckets.text.length} 文本`);
  return parts.join(' · ') || '暂无素材';
}
