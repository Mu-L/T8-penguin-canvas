import type { Edge, Node } from '@xyflow/react';
import { collectMaterialSetBucketsFromData, valueOfMaterialSetItem } from './materialSet.ts';
import { selectSourceHandleData } from './sourceHandleData.ts';
import { dedupeUpstreamMaterialBuckets } from './upstreamMaterialBuckets.ts';
import { shouldCollectNodeTextOutput } from './imageNodeOutputMode.ts';

export type LoopMaterialKind = 'text' | 'image' | 'video' | 'audio';

export interface LoopIterationMaterial {
  id: string;
  kind: LoopMaterialKind;
  url: string;
  sourceNodeId: string;
}

export interface LoopParallelCloneGraph {
  nodes: Node[];
  edges: Edge[];
  cloneNodeIds: string[];
  cloneExecutionSourceById: Record<string, string>;
}

const VIDEO_RE = /\.(mp4|webm|mov|m4v|mkv)(\?|$)/i;
const AUDIO_RE = /\.(mp3|wav|ogg|m4a|flac|aac)(\?|$)/i;
const RUN_REQUEST_ID_PATTERN = /^[a-zA-Z0-9._:-]{8,160}$/;

export function isLoopRunRequestId(value: unknown): value is string {
  return typeof value === 'string' && RUN_REQUEST_ID_PATTERN.test(value);
}

function identityPart(value: string) {
  return encodeURIComponent(String(value));
}

export function loopParallelClonePrefix(loopId: string, requestId: string, iteration: number) {
  return `loop-clone::${identityPart(loopId)}::${identityPart(requestId)}::${Math.max(1, Math.trunc(iteration))}`;
}

export function loopParallelCloneNodeId(loopId: string, requestId: string, iteration: number, nodeIndex: number) {
  return `${loopParallelClonePrefix(loopId, requestId, iteration)}::n${Math.max(0, Math.trunc(nodeIndex))}`;
}

export function loopParallelCloneEdgeId(loopId: string, requestId: string, iteration: number, edgeIndex: number) {
  return `${loopParallelClonePrefix(loopId, requestId, iteration)}::e${Math.max(0, Math.trunc(edgeIndex))}`;
}

export function loopParallelCloneInputEdgeId(loopId: string, requestId: string, iteration: number) {
  return `${loopParallelClonePrefix(loopId, requestId, iteration)}::input`;
}

function record(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
}

/**
 * Pure snapshot equivalent of the material list consumed by LoopNode's
 * `useUpstreamMaterials` hook. It reads exactly one inbound hop and preserves
 * handle routing, material-set ordering, multi-port routing and current-value
 * deduplication. It never executes an upstream node.
 */
export function collectLoopIterationMaterials(
  loopNode: Node,
  nodes: readonly Node[],
  edges: readonly Edge[],
  maxItems = Number.POSITIVE_INFINITY,
): LoopIterationMaterial[] {
  const loopData = record(loopNode.data);
  const kind: LoopMaterialKind = ['text', 'image', 'video', 'audio'].includes(String(loopData.kind))
    ? loopData.kind as LoopMaterialKind
    : 'image';
  const inbound = edges.filter((edge) => edge.target === loopNode.id);
  const upstreamIds = [...new Set(inbound.map((edge) => edge.source))];
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const handleMap = new Map<string, Set<string | null>>();
  for (const edge of inbound) {
    const handles = handleMap.get(edge.source) || new Set<string | null>();
    handles.add(edge.sourceHandle ?? null);
    handleMap.set(edge.source, handles);
  }

  const texts: LoopIterationMaterial[] = [];
  const images: LoopIterationMaterial[] = [];
  const videos: LoopIterationMaterial[] = [];
  const audios: LoopIterationMaterial[] = [];
  const seen = new Set<string>();
  const seenTextFieldEchoes = new Set<string>();
  let rawItemCount = 0;
  const rawLimit = Number.isFinite(maxItems) ? Math.max(0, Math.trunc(maxItems)) : Number.POSITIVE_INFINITY;
  const reserveItem = () => {
    if (rawItemCount >= rawLimit) throw new Error('loop-material-limit');
    rawItemCount += 1;
  };
  const pushText = (sourceId: string, value: unknown, key: string) => {
    if (typeof value !== 'string') return;
    const url = value.trim();
    if (!url || seen.has(key)) return;
    seen.add(key);
    if (key.includes('text-field:')) {
      const echoKey = `${sourceId}::${url}`;
      if (seenTextFieldEchoes.has(echoKey)) return;
      seenTextFieldEchoes.add(echoKey);
    }
    if (kind !== 'text') return;
    reserveItem();
    texts.push({ id: `${sourceId}::${key}`, kind: 'text', url, sourceNodeId: sourceId });
  };
  const pushUrl = (
    sourceId: string,
    materialKind: Exclude<LoopMaterialKind, 'text'>,
    value: unknown,
    _bucket: LoopIterationMaterial[],
    explicitKey?: string,
  ) => {
    if (typeof value !== 'string') return;
    const url = value.trim();
    if (!url) return;
    const key = explicitKey || `${materialKind}:${url}`;
    if (seen.has(key)) return;
    seen.add(key);
    const actualKind: Exclude<LoopMaterialKind, 'text'> = materialKind === 'image' && VIDEO_RE.test(url)
      ? 'video'
      : materialKind === 'image' && AUDIO_RE.test(url)
        ? 'audio'
        : materialKind;
    if (actualKind !== kind) return;
    reserveItem();
    const actualBucket = actualKind === 'image' ? images : actualKind === 'video' ? videos : audios;
    actualBucket.push({ id: `${sourceId}::${key}`, kind: actualKind, url, sourceNodeId: sourceId });
  };

  for (const sourceId of upstreamIds) {
    const source = nodeById.get(sourceId);
    if (!source) continue;
    const handles = handleMap.get(sourceId) || new Set<string | null>([null]);
    const routed = selectSourceHandleData(record(source.data), handles);
    for (const selected of routed) {
      const data = record(selected);
      if (source.type === 'material-set' && Array.isArray(data.materialSetItems)) {
        const buckets = collectMaterialSetBucketsFromData(data);
        buckets.text.forEach((item, index) => pushText(
          sourceId,
          valueOfMaterialSetItem(item),
          `material-set:${sourceId}:text:${index}`,
        ));
        buckets.image.forEach((item, index) => pushUrl(
          sourceId,
          'image',
          item.url,
          images,
          `material-set:${sourceId}:image:${index}`,
        ));
        buckets.video.forEach((item, index) => pushUrl(
          sourceId,
          'video',
          item.url,
          videos,
          `material-set:${sourceId}:video:${index}`,
        ));
        buckets.audio.forEach((item, index) => pushUrl(
          sourceId,
          'audio',
          item.url,
          audios,
          `material-set:${sourceId}:audio:${index}`,
        ));
        continue;
      }

      if (shouldCollectNodeTextOutput(source.type, source.data)) {
        const textArrayField = ['textSegments', 'segments', 'texts']
          .find((field) => Array.isArray(data[field]) && data[field].length > 0);
        if (textArrayField) {
          data[textArrayField].forEach((item: unknown, index: number) => pushText(
            sourceId,
            item,
            `text-array:${sourceId}:${textArrayField}:${index}`,
          ));
        } else {
          pushText(sourceId, data.outputText, `text-field:${sourceId}:outputText`);
          pushText(sourceId, data.reply, `text-field:${sourceId}:reply`);
          let primaryPrompt = '';
          if (typeof data.promptResolved === 'string' && data.promptResolved.trim()) {
            primaryPrompt = data.promptResolved.trim();
            pushText(sourceId, data.promptResolved, `text-field:${sourceId}:promptResolved`);
          } else {
            primaryPrompt = typeof data.prompt === 'string' ? data.prompt.trim() : '';
            pushText(sourceId, data.prompt, `text-field:${sourceId}:prompt`);
          }
          if (typeof data.text === 'string' && data.text.trim() !== primaryPrompt) {
            pushText(sourceId, data.text, `text-field:${sourceId}:text`);
          }
        }
      }

      const framePair = (typeof data.firstFrameUrl === 'string' || typeof data.lastFrameUrl === 'string')
        && Object.hasOwn(data, 'firstFrameUrl')
        && Object.hasOwn(data, 'lastFrameUrl');
      if (framePair) {
        const first = handles.has('first') || (handles.has(null) && !handles.has('last'));
        const last = handles.has('last') || (handles.has(null) && !handles.has('first'));
        if (first) pushUrl(sourceId, 'image', data.firstFrameUrl, images);
        if (last) pushUrl(sourceId, 'image', data.lastFrameUrl, images);
        continue;
      }

      pushUrl(sourceId, 'image', data.imageUrl, images);
      pushUrl(sourceId, 'image', data.resultUrl, images);
      for (const field of ['imageUrls', 'urls', 'generatedImages', 'resultUrls']) {
        if (Array.isArray(data[field])) data[field].forEach((value: unknown) => pushUrl(sourceId, 'image', value, images));
      }
      pushUrl(sourceId, 'video', data.videoUrl, videos);
      if (Array.isArray(data.videoUrls)) data.videoUrls.forEach((value: unknown) => pushUrl(sourceId, 'video', value, videos));

      const suno = Object.hasOwn(data, 'audioUrl') && Object.hasOwn(data, 'audioUrl_1');
      if (suno) {
        const audio0 = handles.has('audio-0') || (handles.has(null) && !handles.has('audio-1'));
        const audio1 = handles.has('audio-1') || (handles.has(null) && !handles.has('audio-0'));
        if (audio0) pushUrl(sourceId, 'audio', data.audioUrl, audios);
        if (audio1) pushUrl(sourceId, 'audio', data.audioUrl_1, audios);
        if (Array.isArray(data.audioUrls)) data.audioUrls.forEach((value: unknown) => pushUrl(sourceId, 'audio', value, audios));
        continue;
      }
      pushUrl(sourceId, 'audio', data.audioUrl, audios);
      pushUrl(sourceId, 'audio', data.audioUrl_1, audios);
      if (Array.isArray(data.audioUrls)) data.audioUrls.forEach((value: unknown) => pushUrl(sourceId, 'audio', value, audios));
    }
  }

  const buckets = dedupeUpstreamMaterialBuckets({ texts, images, videos, audios });
  const selected = kind === 'text' ? buckets.texts
    : kind === 'video' ? buckets.videos
      : kind === 'audio' ? buckets.audios
        : buckets.images;
  if (selected.length > maxItems) throw new Error('loop-material-limit');
  return selected;
}

/**
 * Builds the exact identity/data/edge portion of LoopNode's parallel clone
 * graph. Visual collision offsets are intentionally excluded: run-preflight
 * digests do not authorize position, while runtime and preflight must share
 * these ID helpers and clone data fields.
 */
export function buildLoopParallelCloneGraph(input: {
  loopId: string;
  requestId: string;
  sourceNodes: readonly Node[];
  sourceEdges: readonly Edge[];
  entryEdge: Edge;
  items: readonly LoopIterationMaterial[];
}): LoopParallelCloneGraph {
  if (!isLoopRunRequestId(input.requestId)) throw new Error('loop-request-id-invalid');
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  const cloneNodeIds: string[] = [];
  const cloneExecutionSourceById: Record<string, string> = {};
  for (let iteration = 1; iteration < input.items.length; iteration += 1) {
    const idMap = new Map<string, string>();
    input.sourceNodes.forEach((node, nodeIndex) => {
      idMap.set(node.id, loopParallelCloneNodeId(input.loopId, input.requestId, iteration, nodeIndex));
    });
    for (const source of input.sourceNodes) {
      const cloneId = idMap.get(source.id)!;
      cloneNodeIds.push(cloneId);
      cloneExecutionSourceById[cloneId] = source.id;
      nodes.push({
        ...source,
        id: cloneId,
        position: { ...source.position },
        data: {
          ...record(source.data),
          status: 'idle',
          error: null,
          __loopClone: input.loopId,
          __loopCloneRequestId: input.requestId,
          __loopCloneSourceNodeId: source.id,
          __loopCloneIteration: iteration,
        },
        selected: false,
      });
    }
    input.sourceEdges.forEach((source, edgeIndex) => {
      edges.push({
        ...source,
        id: loopParallelCloneEdgeId(input.loopId, input.requestId, iteration, edgeIndex),
        source: idMap.get(source.source)!,
        target: idMap.get(source.target)!,
      });
    });
    const entryCloneId = idMap.get(input.entryEdge.target);
    if (!entryCloneId) throw new Error('loop-entry-node-missing');
    edges.push({
      id: loopParallelCloneInputEdgeId(input.loopId, input.requestId, iteration),
      source: input.items[iteration].sourceNodeId,
      target: entryCloneId,
      targetHandle: input.entryEdge.targetHandle,
      type: 'deletable',
    });
  }
  return { nodes, edges, cloneNodeIds, cloneExecutionSourceById };
}
