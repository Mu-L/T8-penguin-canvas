export type ImageLongEdgeLimit = 0 | 1024 | 2048;

export function normalizeImageLongEdgeLimit(value: unknown): ImageLongEdgeLimit {
  return value === 1024 || value === 2048 ? value : 0;
}

export function cleanImageUrlList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const item of value) {
    const url = typeof item === 'string' ? item.trim() : '';
    if (!url || seen.has(url)) continue;
    seen.add(url);
    urls.push(url);
  }
  return urls;
}

export function sameImageUrlList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((url, index) => url === b[index]);
}

export function isImageLongEdgeCacheReady(input: {
  limit: ImageLongEdgeLimit;
  sourceUrls: readonly string[];
  cachedLimit: unknown;
  cachedSourceUrls: unknown;
  cachedOutputUrls: unknown;
}): boolean {
  if (input.limit === 0) return true;
  const cachedSources = cleanImageUrlList(input.cachedSourceUrls);
  const cachedOutputs = cleanImageUrlList(input.cachedOutputUrls);
  return (
    input.cachedLimit === input.limit &&
    input.sourceUrls.length > 0 &&
    cachedOutputs.length === input.sourceUrls.length &&
    sameImageUrlList(cachedSources, input.sourceUrls)
  );
}
