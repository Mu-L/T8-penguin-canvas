import { memo } from 'react';
import { Scissors } from 'lucide-react';
import type { NodeProps } from '@xyflow/react';
import { ImageOpFrame } from './ImageOpFrame';
import { opRemoveBg } from '../../services/imageOps';

/**
 * RemoveBgNode - 本地边缘连通纯色背景移除；不是通用 AI 主体分割。
 */
const RemoveBgNode = (p: NodeProps) => {
  return (
    <ImageOpFrame
      id={p.id}
      data={p.data}
      selected={p.selected}
      title="抠图"
      subtitle="边缘连通纯色背景"
      icon={<Scissors size={13} />}
      colorHex="#fb923c"
      bgRgba="rgba(251,146,60,.2)"
      shadowRgba="rgba(251,146,60,.2)"
      textHex="#fed7aa"
      buttonClasses="bg-orange-500/20 hover:bg-orange-500/30 text-orange-200"
      renderSettings={() => (
        <div className="text-[10px] text-white/40 px-1 py-0.5 leading-relaxed">
          本地识别与画面边缘连通的纯色区域并转为透明；复杂背景请使用专业抠像能力。
        </div>
      )}
      runOp={async (img) => opRemoveBg(img as string)}
    />
  );
};

export default memo(RemoveBgNode);
