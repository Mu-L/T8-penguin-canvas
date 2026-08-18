import type { NodeProps } from '@xyflow/react';
import { FASHVSR_VIDEO_UPSCALE_MODEL } from '../../providers/models';
import VideoNode from './VideoNode';

const FashVsrNode = (props: NodeProps) => (
  <VideoNode
    {...props}
    data={{
      ...(props.data as Record<string, unknown>),
      fashVsrVariant: true,
      videoBuiltinSource: 'seedance-nz',
      mainId: 'fashvsr-video-upscale',
      model: FASHVSR_VIDEO_UPSCALE_MODEL,
    }}
  />
);

export default FashVsrNode;
