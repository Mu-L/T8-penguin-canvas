import { memo } from 'react';

interface ReuseResultToggleProps {
  checked: boolean;
  hasResult: boolean;
  onChange: (checked: boolean) => void;
  accentColor?: string;
}

function ReuseResultToggle({
  checked,
  hasResult,
  onChange,
  accentColor = '#a3e635',
}: ReuseResultToggleProps) {
  const hint = checked
    ? hasResult
      ? '已有结果：运行时跳过本节点，直接继续下游'
      : '暂无结果：本次仍会正常生成'
    : '关闭时每次运行都会重新生成';

  return (
    <label
      className="nodrag nowheel flex cursor-pointer items-start gap-2 rounded px-2 py-1.5"
      style={{
        border: '1px solid var(--border-primary)',
        background: 'var(--bg-secondary)',
        color: 'var(--text-primary)',
      }}
      onMouseDown={(event) => event.stopPropagation()}
      onWheel={(event) => event.stopPropagation()}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.currentTarget.checked)}
        className="mt-0.5 h-3.5 w-3.5 shrink-0"
        style={{ accentColor }}
        aria-label="复用结果"
      />
      <span className="min-w-0">
        <span className="block text-[11px] font-semibold leading-4">复用结果</span>
        <span className="block text-[9px] leading-4" style={{ color: 'var(--text-secondary)' }}>{hint}</span>
      </span>
    </label>
  );
}

export default memo(ReuseResultToggle);
