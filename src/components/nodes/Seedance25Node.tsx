import type { NodeProps } from '@xyflow/react';
import SeedanceNode from './SeedanceNode';

const Seedance25Node = (props: NodeProps) => (
  <SeedanceNode {...props} data={{ ...(props.data as any), seedance25Variant: true }} />
);

export default Seedance25Node;
