import {
  forwardRef,
  useCallback,
  useEffect,
  useRef,
  useState,
  type VideoHTMLAttributes,
} from 'react';
import { compatibleVideoPreviewUrl } from '../utils/videoPlayback';
import {
  observeVisibleMediaLoad,
  type VisibleMediaLoadController,
} from '../utils/mediaLoadScheduler';

export type LazyVideoProps = VideoHTMLAttributes<HTMLVideoElement> & {
  src?: string;
};

const LazyVideo = forwardRef<HTMLVideoElement, LazyVideoProps>(function LazyVideo({
  src,
  preload = 'metadata',
  autoPlay = false,
  onLoadedMetadata,
  onCanPlay,
  onPlay,
  onPause,
  onEnded,
  onError,
  onPointerDown,
  onFocus,
  onKeyDown,
  ...props
}, forwardedRef) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const controllerRef = useRef<VisibleMediaLoadController | null>(null);
  const releaseLoadSlotRef = useRef<(() => void) | null>(null);
  const pendingPlayRef = useRef(false);
  const playIntentRef = useRef(Boolean(autoPlay));
  const visibilityPauseRef = useRef(false);
  const visibleRef = useRef(false);
  const eager = preload === 'auto';
  const playbackSrc = src ? compatibleVideoPreviewUrl(src) : src;
  const [loadedKey, setLoadedKey] = useState<string | null>(() => eager && playbackSrc ? playbackSrc : null);
  const shouldLoad = !src || eager || loadedKey === playbackSrc;

  const setVideoRef = useCallback((element: HTMLVideoElement | null) => {
    videoRef.current = element;
    if (typeof forwardedRef === 'function') forwardedRef(element);
    else if (forwardedRef) forwardedRef.current = element;
  }, [forwardedRef]);

  useEffect(() => {
    pendingPlayRef.current = false;
    playIntentRef.current = Boolean(autoPlay);
    visibilityPauseRef.current = false;
    visibleRef.current = false;
  }, [autoPlay, playbackSrc]);

  useEffect(() => {
    controllerRef.current = null;
    if (!src || eager) return;
    const element = videoRef.current;
    if (!element) return;
    const controller = observeVisibleMediaLoad(
      element,
      'video',
      (release) => {
        releaseLoadSlotRef.current?.();
        releaseLoadSlotRef.current = release;
        setLoadedKey(playbackSrc || null);
      },
      {
        onVisibilityChange: autoPlay
          ? (isVisible) => {
              visibleRef.current = isVisible;
              const video = videoRef.current;
              if (!video) return;
              if (!isVisible) {
                if (!video.paused) {
                  visibilityPauseRef.current = true;
                  playIntentRef.current = true;
                  video.pause();
                }
                return;
              }
              if (playIntentRef.current && video.getAttribute('src')) {
                void video.play().catch(() => undefined);
              }
            }
          : undefined,
      },
    );
    controllerRef.current = controller;
    return () => {
      if (controllerRef.current === controller) controllerRef.current = null;
      controller.cancel();
      releaseLoadSlotRef.current?.();
      releaseLoadSlotRef.current = null;
    };
  }, [autoPlay, eager, playbackSrc, src]);

  const releaseLoadSlot = () => {
    releaseLoadSlotRef.current?.();
    releaseLoadSlotRef.current = null;
  };
  const requestPendingPlay = () => {
    if (src && !shouldLoad) {
      pendingPlayRef.current = true;
      playIntentRef.current = true;
    }
    controllerRef.current?.request();
  };

  return (
    <video
      {...props}
      ref={setVideoRef}
      src={shouldLoad ? playbackSrc : undefined}
      data-full-src={src}
      data-playback-src={playbackSrc}
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
        if (autoPlay && !visibleRef.current) {
          visibilityPauseRef.current = true;
          event.currentTarget.pause();
        } else if (pendingPlayRef.current || (autoPlay && playIntentRef.current)) {
          pendingPlayRef.current = false;
          void event.currentTarget.play().catch(() => undefined);
        }
        onCanPlay?.(event);
      }}
      onPlay={(event) => {
        if (autoPlay && !visibleRef.current) {
          visibilityPauseRef.current = true;
          event.currentTarget.pause();
        } else {
          playIntentRef.current = true;
        }
        onPlay?.(event);
      }}
      onPause={(event) => {
        if (visibilityPauseRef.current) visibilityPauseRef.current = false;
        else playIntentRef.current = false;
        onPause?.(event);
      }}
      onEnded={(event) => {
        playIntentRef.current = false;
        pendingPlayRef.current = false;
        onEnded?.(event);
      }}
      onError={(event) => {
        pendingPlayRef.current = false;
        releaseLoadSlot();
        onError?.(event);
      }}
    />
  );
});

export default LazyVideo;
