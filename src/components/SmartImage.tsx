import { useEffect, useMemo, useRef, useState, type ImgHTMLAttributes } from 'react';
import { previewImageUrl } from '../utils/mediaPreview';
import { observeVisibleMediaLoad } from '../utils/mediaLoadScheduler';

type SmartImageProps = ImgHTMLAttributes<HTMLImageElement> & {
  src: string;
  thumbSize?: number;
};

export default function SmartImage({
  src,
  thumbSize = 360,
  loading = 'lazy',
  decoding = 'async',
  onLoad,
  onError,
  ...props
}: SmartImageProps) {
  const imgRef = useRef<HTMLImageElement | null>(null);
  const releaseLoadSlotRef = useRef<(() => void) | null>(null);
  const previewSrc = useMemo(() => previewImageUrl(src, thumbSize), [src, thumbSize]);
  const [loadedKey, setLoadedKey] = useState<string | null>(() => loading !== 'lazy' ? previewSrc : null);
  const [fallbackKey, setFallbackKey] = useState<string | null>(null);
  const shouldLoad = loading !== 'lazy' || loadedKey === previewSrc;
  const fallback = fallbackKey === previewSrc;

  useEffect(() => {
    if (loading !== 'lazy' || !src) return;
    const element = imgRef.current;
    if (!element) return;
    const controller = observeVisibleMediaLoad(element, 'image', (release) => {
      releaseLoadSlotRef.current?.();
      releaseLoadSlotRef.current = release;
      setLoadedKey(previewSrc);
    });
    return () => {
      controller.cancel();
      releaseLoadSlotRef.current?.();
      releaseLoadSlotRef.current = null;
    };
  }, [loading, previewSrc, src]);

  const actualSrc = shouldLoad ? (fallback ? src : previewSrc) : undefined;
  const releaseLoadSlot = () => {
    releaseLoadSlotRef.current?.();
    releaseLoadSlotRef.current = null;
  };

  return (
    <img
      {...props}
      ref={imgRef}
      src={actualSrc}
      data-full-src={src}
      data-preview-src={previewSrc}
      loading={loading}
      decoding={decoding}
      onLoad={(event) => {
        releaseLoadSlot();
        onLoad?.(event);
      }}
      onError={(event) => {
        if (!actualSrc) return;
        if (!fallback && actualSrc !== src) {
          setFallbackKey(previewSrc);
          return;
        }
        releaseLoadSlot();
        onError?.(event);
      }}
    />
  );
}
