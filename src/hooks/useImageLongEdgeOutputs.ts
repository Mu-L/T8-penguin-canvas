import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { opResizeLongEdge } from '../services/imageOps';
import {
  cleanImageUrlList,
  isImageLongEdgeCacheReady,
  normalizeImageLongEdgeLimit,
  type ImageLongEdgeLimit,
} from '../utils/imageLongEdge';

interface ImageLongEdgeData {
  imageLongEdgeLimit?: unknown;
  imageLongEdgeAppliedLimit?: unknown;
  imageLongEdgeSourceUrls?: unknown;
  imageLongEdgeOutputUrls?: unknown;
}

interface UseImageLongEdgeOutputsOptions {
  sourceUrls: string[];
  data: ImageLongEdgeData;
  update: (patch: Record<string, unknown>) => void;
  onError?: (message: string) => void;
}

export function useImageLongEdgeOutputs({
  sourceUrls,
  data,
  update,
  onError,
}: UseImageLongEdgeOutputsOptions) {
  const limit = normalizeImageLongEdgeLimit(data.imageLongEdgeLimit);
  const cleanSources = useMemo(() => cleanImageUrlList(sourceUrls), [sourceUrls.join('\u241F')]);
  const cachedOutputs = useMemo(
    () => cleanImageUrlList(data.imageLongEdgeOutputUrls),
    [JSON.stringify(data.imageLongEdgeOutputUrls || [])],
  );
  const ready = isImageLongEdgeCacheReady({
    limit,
    sourceUrls: cleanSources,
    cachedLimit: data.imageLongEdgeAppliedLimit,
    cachedSourceUrls: data.imageLongEdgeSourceUrls,
    cachedOutputUrls: cachedOutputs,
  });
  const [busy, setBusy] = useState(false);
  const requestRef = useRef(0);
  const sourceSignature = cleanSources.join('\u241F');

  const selectLimit = useCallback((next: ImageLongEdgeLimit) => {
    requestRef.current += 1;
    setBusy(false);
    update({
      imageLongEdgeLimit: next,
      imageLongEdgeAppliedLimit: 0,
      imageLongEdgeSourceUrls: [],
      imageLongEdgeOutputUrls: [],
    });
  }, [update]);

  useEffect(() => {
    if (limit === 0 || cleanSources.length === 0 || ready) return;
    const requestId = ++requestRef.current;
    let active = true;
    setBusy(true);
    onError?.('');

    void (async () => {
      try {
        const outputs: string[] = [];
        // 大图逐张处理，避免多张百 MB 图片同时进入 Sharp。
        for (const sourceUrl of cleanSources) {
          const result = await opResizeLongEdge(sourceUrl, limit);
          outputs.push(result.imageUrl);
        }
        if (!active || requestRef.current !== requestId) return;
        update({
          imageLongEdgeAppliedLimit: limit,
          imageLongEdgeSourceUrls: cleanSources,
          imageLongEdgeOutputUrls: outputs,
        });
      } catch (error) {
        if (!active || requestRef.current !== requestId) return;
        const message = error instanceof Error ? error.message : String(error || '图片缩放失败');
        onError?.(`图片长边缩放失败：${message}`);
      } finally {
        if (active && requestRef.current === requestId) setBusy(false);
      }
    })();

    return () => {
      active = false;
    };
  }, [cleanSources, limit, onError, ready, sourceSignature, update]);

  return {
    limit,
    busy,
    ready,
    selectLimit,
    outputUrls: limit === 0 ? cleanSources : ready ? cachedOutputs : [],
    previewUrls: limit === 0 || ready ? (limit === 0 ? cleanSources : cachedOutputs) : cleanSources,
  };
}
