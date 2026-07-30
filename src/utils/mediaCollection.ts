export type MediaKind = 'image' | 'video' | 'audio' | 'model3d';

export interface MediaItem {
  kind: MediaKind;
  url: string;
  name?: string;
  size?: number;
  mime?: string;
}

export const MEDIA_KIND_META: Record<MediaKind, {
  label: string;
  singleField: 'imageUrl' | 'videoUrl' | 'audioUrl' | 'modelUrl';
  arrayField: 'imageUrls' | 'videoUrls' | 'audioUrls' | 'modelUrls';
  directSingleField: 'directImageUrl' | 'directVideoUrl' | 'directAudioUrl' | 'directModelUrl';
  directArrayField: 'directImageUrls' | 'directVideoUrls' | 'directAudioUrls' | 'directModelUrls';
}> = {
  image: {
    label: '图像',
    singleField: 'imageUrl',
    arrayField: 'imageUrls',
    directSingleField: 'directImageUrl',
    directArrayField: 'directImageUrls',
  },
  video: {
    label: '视频',
    singleField: 'videoUrl',
    arrayField: 'videoUrls',
    directSingleField: 'directVideoUrl',
    directArrayField: 'directVideoUrls',
  },
  audio: {
    label: '音频',
    singleField: 'audioUrl',
    arrayField: 'audioUrls',
    directSingleField: 'directAudioUrl',
    directArrayField: 'directAudioUrls',
  },
  model3d: {
    label: '3D模型',
    singleField: 'modelUrl',
    arrayField: 'modelUrls',
    directSingleField: 'directModelUrl',
    directArrayField: 'directModelUrls',
  },
};

export function fileNameFromUrl(url: string): string {
  try {
    const clean = url.split('?')[0].split('#')[0];
    return decodeURIComponent(clean.split('/').pop() || url);
  } catch {
    return url.split('/').pop() || url;
  }
}

export function formatMediaSize(size?: number): string {
  if (!Number.isFinite(size || 0) || !size) return '';
  if (size >= 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`;
  return `${(size / 1024).toFixed(1)} KB`;
}

function pushItem(
  out: MediaItem[],
  seen: Set<string>,
  kind: MediaKind,
  url: any,
  name?: any,
  size?: any,
  mime?: any,
) {
  if (typeof url !== 'string') return;
  const s = url.trim();
  if (!s || seen.has(s)) return;
  seen.add(s);
  out.push({
    kind,
    url: s,
    name: typeof name === 'string' && name ? name : fileNameFromUrl(s),
    size: typeof size === 'number' ? size : undefined,
    mime: typeof mime === 'string' ? mime : undefined,
  });
}

export function getMediaItemsFromData(data: any, kind: MediaKind): MediaItem[] {
  const out: MediaItem[] = [];
  const seen = new Set<string>();
  if (!data) return out;
  const meta = MEDIA_KIND_META[kind];
  const names = Array.isArray(data.fileNames) ? data.fileNames : [];
  const sizes = Array.isArray(data.fileSizes) ? data.fileSizes : [];
  const mimes = Array.isArray(data.mimes) ? data.mimes : [];

  const arr = data[meta.arrayField];
  if (Array.isArray(arr)) {
    arr.forEach((url: any, i: number) => pushItem(out, seen, kind, url, names[i], sizes[i], mimes[i]));
  }

  const directArr = data[meta.directArrayField];
  if (Array.isArray(directArr)) {
    directArr.forEach((url: any, i: number) => pushItem(out, seen, kind, url, names[i], sizes[i], mimes[i]));
  }

  if (kind === 'image' && Array.isArray(data.resultUrls)) {
    data.resultUrls.forEach((url: any, i: number) => pushItem(out, seen, kind, url, names[i], sizes[i], mimes[i]));
  }

  pushItem(out, seen, kind, data[meta.singleField], data.fileName, data.fileSize, data.mime);
  pushItem(out, seen, kind, data[meta.directSingleField], data.fileName, data.fileSize, data.mime);
  if (kind === 'image') {
    pushItem(out, seen, kind, data.resultUrl, data.fileName, data.fileSize, data.mime);
  }
  return out;
}

export function createUploadDataFromItems(kind: MediaKind, items: MediaItem[]): Record<string, any> {
  const meta = MEDIA_KIND_META[kind];
  const clean = items.filter((item) => item.kind === kind && item.url);
  const first = clean[0];
  if (!first) return { uploadType: kind };
  return {
    uploadType: kind,
    [meta.singleField]: first.url,
    [meta.arrayField]: clean.map((item) => item.url),
    fileName: first.name || fileNameFromUrl(first.url),
    fileNames: clean.map((item) => item.name || fileNameFromUrl(item.url)),
    fileSize: first.size || 0,
    fileSizes: clean.map((item) => item.size || 0),
    mime: first.mime || '',
    mimes: clean.map((item) => item.mime || ''),
  };
}

export function createUploadDataFromItem(item: MediaItem): Record<string, any> {
  return createUploadDataFromItems(item.kind, [item]);
}

export function createEmptyUploadMediaData(): Record<string, any> {
  const data: Record<string, any> = {
    uploadType: null,
    fileName: '',
    fileNames: [],
    fileSize: 0,
    fileSizes: [],
    mime: '',
    mimes: [],
    imageLongEdgeLimit: 0,
    imageLongEdgeAppliedLimit: 0,
    imageLongEdgeSourceItems: [],
    imageLongEdgeSourceUrls: [],
    imageLongEdgeOutputUrls: [],
  };
  for (const meta of Object.values(MEDIA_KIND_META)) {
    data[meta.singleField] = undefined;
    data[meta.arrayField] = [];
    data[meta.directSingleField] = undefined;
    data[meta.directArrayField] = [];
  }
  return data;
}

export function createUploadReplacementData(kind: MediaKind, items: MediaItem[]): Record<string, any> {
  return {
    ...createEmptyUploadMediaData(),
    ...createUploadDataFromItems(kind, items),
  };
}

export function createUploadMediaRemovalData(
  data: any,
  kind: MediaKind,
  index: number,
  emptyUploadType: MediaKind | null = null,
): Record<string, any> {
  const items = getMediaItemsFromData(data, kind);
  const nextItems = items.filter((_, i) => i !== index);
  if (nextItems.length === 0) {
    return {
      ...createEmptyUploadMediaData(),
      uploadType: emptyUploadType,
    };
  }
  return createUploadReplacementData(kind, nextItems);
}

export function createOutputDataFromItems(kind: MediaKind, items: MediaItem[]): Record<string, any> {
  const meta = MEDIA_KIND_META[kind];
  const clean = items.filter((item) => item.kind === kind && item.url);
  const first = clean[0];
  if (!first) return {};
  const urls = clean.map((item) => item.url);
  return {
    [meta.singleField]: first.url,
    [meta.arrayField]: urls,
    [meta.directSingleField]: first.url,
    [meta.directArrayField]: urls,
    fileName: first.name || fileNameFromUrl(first.url),
    fileNames: clean.map((item) => item.name || fileNameFromUrl(item.url)),
    fileSize: first.size || 0,
    fileSizes: clean.map((item) => item.size || 0),
    mime: first.mime || '',
    mimes: clean.map((item) => item.mime || ''),
  };
}

export function createOutputDataFromItem(item: MediaItem): Record<string, any> {
  return createOutputDataFromItems(item.kind, [item]);
}

function asStringArray(value: any): string[] {
  return Array.isArray(value)
    ? value.map((item) => (typeof item === 'string' ? item.trim() : '')).filter(Boolean)
    : [];
}

function withoutUrl(value: any, url: string): string[] {
  const target = url.trim();
  return asStringArray(value).filter((item) => item !== target);
}

function hiddenMaterialUrlPatch(data: any, kind: MediaKind, url: string): Record<MediaKind, string[]> {
  const current = data?.hiddenMaterialUrls && typeof data.hiddenMaterialUrls === 'object'
    ? data.hiddenMaterialUrls
    : {};
  const next: Record<MediaKind, string[]> = {
    image: asStringArray(current.image),
    video: asStringArray(current.video),
    audio: asStringArray(current.audio),
    model3d: asStringArray(current.model3d),
  };
  const target = url.trim();
  if (target && !next[kind].includes(target)) {
    next[kind] = [...next[kind], target];
  }
  return next;
}

export function isMaterialUrlHidden(data: any, kind: MediaKind, url: string): boolean {
  const current = data?.hiddenMaterialUrls && typeof data.hiddenMaterialUrls === 'object'
    ? data.hiddenMaterialUrls
    : {};
  return asStringArray(current[kind]).includes(url.trim());
}

export function createOutputMediaRemovalData(data: any, kind: MediaKind, url: string): Record<string, any> {
  const meta = MEDIA_KIND_META[kind];
  const nextArray = withoutUrl(data?.[meta.arrayField], url);
  const nextDirectArray = withoutUrl(data?.[meta.directArrayField], url);
  const target = url.trim();
  const patch: Record<string, any> = {
    [meta.arrayField]: nextArray,
    [meta.directArrayField]: nextDirectArray,
    hiddenMaterialUrls: hiddenMaterialUrlPatch(data, kind, target),
  };

  const currentSingle = typeof data?.[meta.singleField] === 'string' ? data[meta.singleField].trim() : '';
  const currentDirectSingle = typeof data?.[meta.directSingleField] === 'string' ? data[meta.directSingleField].trim() : '';
  patch[meta.singleField] = currentSingle === target ? nextArray[0] : data?.[meta.singleField];
  patch[meta.directSingleField] = currentDirectSingle === target ? nextDirectArray[0] : data?.[meta.directSingleField];

  if (kind === 'image') {
    patch.urls = withoutUrl(data?.urls, target);
    patch.generatedImages = withoutUrl(data?.generatedImages, target);
  }
  if (kind === 'audio') {
    const currentSecondAudio = typeof data?.audioUrl_1 === 'string' ? data.audioUrl_1.trim() : '';
    patch.audioUrl_1 = currentSecondAudio === target ? '' : data?.audioUrl_1;
  }

  return patch;
}

export function sameMediaUrls(a: MediaItem[], b: MediaItem[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((item, index) => item.kind === b[index]?.kind && item.url === b[index]?.url);
}
