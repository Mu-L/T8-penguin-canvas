export const LOOPING_VIDEO_DEFAULT_PROPS = {
  loop: true,
  playsInline: true,
  preload: 'metadata',
} as const;

const LOCAL_MOV_VIDEO_RE = /^\/(?:files\/(?:input|output)|input|output)\/.+\.mov(?:[?#].*)?$/i;

export function needsCompatibleVideoPreview(src: unknown): src is string {
  return typeof src === 'string' && LOCAL_MOV_VIDEO_RE.test(src.trim());
}

export function compatibleVideoPreviewUrl(src: string): string {
  const clean = String(src || '').trim();
  return needsCompatibleVideoPreview(clean)
    ? `/api/files/video-preview?url=${encodeURIComponent(clean)}`
    : clean;
}

export function mergeLoopingVideoProps<T extends Record<string, unknown>>(props: T): typeof LOOPING_VIDEO_DEFAULT_PROPS & T {
  return {
    ...LOOPING_VIDEO_DEFAULT_PROPS,
    ...props,
    loop: true,
  };
}
