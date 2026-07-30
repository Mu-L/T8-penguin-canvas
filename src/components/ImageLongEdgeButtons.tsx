import type { ImageLongEdgeLimit } from '../utils/imageLongEdge';

interface ImageLongEdgeButtonsProps {
  value: ImageLongEdgeLimit;
  busy?: boolean;
  disabled?: boolean;
  onChange: (value: ImageLongEdgeLimit) => void;
}

export default function ImageLongEdgeButtons({
  value,
  busy = false,
  disabled = false,
  onChange,
}: ImageLongEdgeButtonsProps) {
  return (
    <div
      className="nodrag nopan flex items-center gap-0.5"
      title="限制输出图片长边；保持原始宽高比，不裁剪。再次点击已选尺寸可恢复原图。"
      onPointerDown={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
    >
      {([1024, 2048] as const).map((limit) => {
        const active = value === limit;
        return (
          <button
            key={limit}
            type="button"
            aria-pressed={active}
            disabled={disabled || busy}
            className={`h-5 min-w-7 rounded border px-1 text-[9px] font-semibold transition ${
              active
                ? 'border-emerald-400/80 bg-emerald-400/20 text-emerald-300'
                : 'border-current/20 bg-black/10 opacity-70 hover:opacity-100'
            } disabled:cursor-wait disabled:opacity-40`}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onChange(active ? 0 : limit);
            }}
          >
            {limit === 1024 ? '1K' : '2K'}
          </button>
        );
      })}
    </div>
  );
}
