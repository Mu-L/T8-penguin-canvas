import { forwardRef, type VideoHTMLAttributes } from 'react';
import { mergeLoopingVideoProps } from '../utils/videoPlayback';
import LazyVideo from './LazyVideo';

export type LoopingVideoProps = VideoHTMLAttributes<HTMLVideoElement> & {
  src?: string;
};

const LoopingVideo = forwardRef<HTMLVideoElement, LoopingVideoProps>(function LoopingVideo({
  src,
  preload,
  ...props
}, forwardedRef) {
  const videoProps = preload === undefined ? props : { ...props, preload };
  const merged = mergeLoopingVideoProps(videoProps as Record<string, unknown>) as LoopingVideoProps;
  return <LazyVideo {...merged} ref={forwardedRef} src={src} />;
});

export default LoopingVideo;
