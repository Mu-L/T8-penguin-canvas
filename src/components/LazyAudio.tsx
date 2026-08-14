import {
  forwardRef,
  useCallback,
  useEffect,
  useRef,
  useState,
  type AudioHTMLAttributes,
} from 'react';
import {
  observeVisibleMediaLoad,
  type VisibleMediaLoadController,
} from '../utils/mediaLoadScheduler';

export type LazyAudioProps = AudioHTMLAttributes<HTMLAudioElement> & {
  src?: string;
};

const LazyAudio = forwardRef<HTMLAudioElement, LazyAudioProps>(function LazyAudio({
  src,
  preload = 'none',
  autoPlay = false,
  onLoadedMetadata,
  onCanPlay,
  onError,
  onPointerDown,
  onFocus,
  onKeyDown,
  ...props
}, forwardedRef) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const controllerRef = useRef<VisibleMediaLoadController | null>(null);
  const releaseLoadSlotRef = useRef<(() => void) | null>(null);
  const pendingPlayRef = useRef(Boolean(autoPlay));
  const eager = preload === 'auto';
  const [loadedKey, setLoadedKey] = useState<string | null>(() => eager && src ? src : null);
  const shouldLoad = !src || eager || loadedKey === src;

  const setAudioRef = useCallback((element: HTMLAudioElement | null) => {
    audioRef.current = element;
    if (typeof forwardedRef === 'function') forwardedRef(element);
    else if (forwardedRef) forwardedRef.current = element;
  }, [forwardedRef]);

  useEffect(() => {
    pendingPlayRef.current = Boolean(autoPlay);
  }, [autoPlay, src]);

  useEffect(() => {
    controllerRef.current = null;
    if (!src || eager) return;
    const element = audioRef.current;
    if (!element) return;
    const controller = observeVisibleMediaLoad(element, 'audio', (release) => {
      releaseLoadSlotRef.current?.();
      releaseLoadSlotRef.current = release;
      setLoadedKey(src);
    });
    controllerRef.current = controller;
    return () => {
      if (controllerRef.current === controller) controllerRef.current = null;
      controller.cancel();
      releaseLoadSlotRef.current?.();
      releaseLoadSlotRef.current = null;
    };
  }, [eager, src]);

  const releaseLoadSlot = () => {
    releaseLoadSlotRef.current?.();
    releaseLoadSlotRef.current = null;
  };
  const requestPendingPlay = () => {
    if (src && !shouldLoad) pendingPlayRef.current = true;
    controllerRef.current?.request();
  };

  return (
    <audio
      {...props}
      ref={setAudioRef}
      src={shouldLoad ? src : undefined}
      data-full-src={src}
      preload={preload}
      autoPlay={autoPlay}
      onPointerDown={(event) => {
        requestPendingPlay();
        onPointerDown?.(event);
      }}
      onFocus={(event) => {
        controllerRef.current?.request();
        onFocus?.(event);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') requestPendingPlay();
        onKeyDown?.(event);
      }}
      onLoadedMetadata={(event) => {
        releaseLoadSlot();
        onLoadedMetadata?.(event);
      }}
      onCanPlay={(event) => {
        if (pendingPlayRef.current) {
          pendingPlayRef.current = false;
          void event.currentTarget.play().catch(() => undefined);
        }
        onCanPlay?.(event);
      }}
      onError={(event) => {
        pendingPlayRef.current = false;
        releaseLoadSlot();
        onError?.(event);
      }}
    />
  );
});

export default LazyAudio;
