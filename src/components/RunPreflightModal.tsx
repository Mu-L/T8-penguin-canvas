import { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import {
  AlertTriangle,
  CircleAlert,
  Info,
  LoaderCircle,
  Play,
  ShieldCheck,
  ShieldX,
  X,
} from 'lucide-react';
import type {
  RunActionKind,
  RunActionPreview,
  RunPreflightNotice,
  RunPreflightNoticeDomain,
} from '../utils/runPreflight';

export interface RunPreflightModalProps {
  preview: RunActionPreview | null;
  loading: boolean;
  onConfirm: (preview: RunActionPreview) => void;
  onCancel: () => void;
}

const ACTION_LABELS: Record<RunActionKind, string> = {
  'run-all': '运行全部节点',
  'run-group': '运行节点组',
  'run-single': '运行单节点',
  'replay-run': '重放 Run',
  'replay-node-run': '重放 NodeRun',
  'replay-attempt': '重放 Attempt',
  'replay-subflow': '重放子工作流',
  'retry-run': '重试 Run',
  'retry-node-run': '重试 NodeRun',
  'retry-attempt': '重试 Attempt',
  'retry-subflow': '重试子工作流',
  'run-intent': '接受远程运行请求',
  'run-intent-auto-approved': '执行已自动批准的远程请求',
};

const DOMAIN_LABELS: Record<RunPreflightNoticeDomain, string> = {
  action: '执行动作',
  scope: '执行范围',
  revision: '画布版本',
  evidence: '运行证据',
  cost: '费用',
  structure: '画布结构',
  capability: 'Provider 能力',
  asset: '素材',
  policy: '主机策略',
};

function revisionLabel(value: number | null) {
  return value === null ? '未提供' : `r${value}`;
}

function EvidenceRef({ value }: { value: RunActionPreview['evidenceRefs'][number] }) {
  return (
    <li className="grid gap-1 rounded border border-[var(--border-primary)] bg-[var(--bg-primary)] px-3 py-2 font-mono text-[10px] sm:grid-cols-3">
      <span className="min-w-0 break-all"><strong className="font-sans text-[var(--text-secondary)]">Run</strong> {value.runId}</span>
      <span className="min-w-0 break-all"><strong className="font-sans text-[var(--text-secondary)]">NodeRun</strong> {value.nodeRunId || '—'}</span>
      <span className="min-w-0 break-all"><strong className="font-sans text-[var(--text-secondary)]">Attempt</strong> {value.attemptId || '—'}</span>
    </li>
  );
}

function NoticeList({
  kind,
  items,
}: {
  kind: 'blocker' | 'warning';
  items: RunPreflightNotice[];
}) {
  if (items.length === 0) return null;
  const blocker = kind === 'blocker';
  const Icon = blocker ? CircleAlert : AlertTriangle;
  return (
    <section
      aria-label={blocker ? '阻断项' : '警告'}
      className="rounded-md border border-[var(--border-primary)] bg-[var(--bg-primary)]"
      data-testid={`run-preflight-${kind}s`}
    >
      <header className="flex items-center gap-2 border-b border-[var(--border-primary)] px-3 py-2 text-xs font-bold">
        <Icon
          aria-hidden="true"
          size={15}
          style={{ color: blocker ? 'var(--danger, #ef4444)' : 'var(--warning, #f59e0b)' }}
        />
        {blocker ? '阻断项' : '需要确认的警告'} · {items.length}
      </header>
      <ul className="divide-y divide-[var(--border-primary)]">
        {items.map((item, index) => (
          <li key={`${item.domain}:${item.code}:${index}`} className="px-3 py-2.5">
            <div className="flex flex-wrap items-center gap-1.5 text-[10px] text-[var(--text-secondary)]">
              <span className="rounded bg-[var(--bg-tertiary)] px-1.5 py-0.5 font-semibold">{DOMAIN_LABELS[item.domain]}</span>
              <code className="break-all">{item.code}</code>
            </div>
            <p className="mt-1 break-words text-xs leading-5 text-[var(--text-primary)]">{item.message}</p>
            {item.nodeIds.length > 0 && (
              <p className="mt-1 break-all text-[10px] text-[var(--text-secondary)]">
                节点：{item.nodeIds.join('、')}
              </p>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function PreviewDetails({ preview }: { preview: RunActionPreview }) {
  const statusLabel = preview.status === 'blocked'
    ? '体检阻断'
    : preview.status === 'confirmation-required'
      ? '需要明确确认'
      : '体检通过';
  const StatusIcon = preview.status === 'blocked' ? ShieldX : ShieldCheck;
  const statusColor = preview.status === 'blocked'
    ? 'var(--danger, #ef4444)'
    : preview.status === 'confirmation-required'
      ? 'var(--warning, #f59e0b)'
      : 'var(--success, #22c55e)';

  return (
    <>
      <section className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto]">
        <div className="rounded-md border border-[var(--border-primary)] bg-[var(--bg-primary)] p-3">
          <div className="flex items-center gap-2 text-sm font-bold">
            <StatusIcon aria-hidden="true" size={17} style={{ color: statusColor }} />
            {statusLabel}
          </div>
          <p className="mt-1 text-xs leading-5 text-[var(--text-secondary)]">
            {ACTION_LABELS[preview.actionKind]} · {preview.scope.selectedNodeCount} 个可执行节点
          </p>
        </div>
        <div className="rounded-md border border-[var(--border-primary)] bg-[var(--bg-primary)] px-3 py-2 sm:min-w-48">
          <div className="text-[10px] text-[var(--text-secondary)]">费用估算</div>
          {preview.cost.known ? (
            <div className="mt-1 break-all text-sm font-bold" data-testid="run-preflight-known-cost">
              {String(preview.cost.amount)} {preview.cost.currency}
            </div>
          ) : (
            <div className="mt-1 text-xs font-bold" data-testid="run-preflight-unknown-cost">
              权威费用未知
              <span className="mt-0.5 block text-[10px] font-normal text-[var(--text-secondary)]">不推断金额或调用次数</span>
            </div>
          )}
        </div>
      </section>

      <section className="rounded-md border border-[var(--border-primary)] bg-[var(--bg-primary)] p-3" aria-label="执行范围">
        <h3 className="text-xs font-bold">动作与执行范围</h3>
        <dl className="mt-2 grid gap-x-5 gap-y-2 text-xs sm:grid-cols-2">
          <div><dt className="text-[10px] text-[var(--text-secondary)]">动作</dt><dd className="mt-0.5 font-semibold">{ACTION_LABELS[preview.actionKind]}</dd></div>
          <div><dt className="text-[10px] text-[var(--text-secondary)]">Revision</dt><dd className="mt-0.5 font-semibold">当前 {revisionLabel(preview.scope.currentRevision)} · 预期 {revisionLabel(preview.scope.expectedRevision)}</dd></div>
          <div><dt className="text-[10px] text-[var(--text-secondary)]">项目</dt><dd className="mt-0.5 break-all font-mono text-[10px]">{preview.scope.projectId || '未提供'}</dd></div>
          <div><dt className="text-[10px] text-[var(--text-secondary)]">画布</dt><dd className="mt-0.5 break-all font-mono text-[10px]">{preview.scope.canvasId || '未提供'}</dd></div>
          <div><dt className="text-[10px] text-[var(--text-secondary)]">图规模</dt><dd className="mt-0.5 font-semibold">{preview.scope.canvasNodeCount} 节点 · {preview.scope.canvasEdgeCount} 连线</dd></div>
          <div><dt className="text-[10px] text-[var(--text-secondary)]">节点集摘要</dt><dd className="mt-0.5 break-all font-mono text-[10px]">{preview.scope.nodeSetDigest}</dd></div>
          <div className="sm:col-span-2"><dt className="text-[10px] text-[var(--text-secondary)]">执行图摘要</dt><dd className="mt-0.5 break-all font-mono text-[10px]">{preview.scope.executionGraphDigest}</dd></div>
          {preview.scope.requestId && (
            <div className="sm:col-span-2"><dt className="text-[10px] text-[var(--text-secondary)]">远程请求</dt><dd className="mt-0.5 break-all font-mono text-[10px]">{preview.scope.requestId}</dd></div>
          )}
        </dl>
        <div className="mt-3 rounded border border-[var(--border-primary)] bg-[var(--bg-secondary)] px-2.5 py-2">
          <div className="text-[10px] font-semibold text-[var(--text-secondary)]">
            执行节点 {preview.scope.selectedNodeCount} 个{preview.scope.nodeIdsTruncated ? ' · 列表已有界省略' : ''}
          </div>
          <p className="mt-1 max-h-24 overflow-auto break-all font-mono text-[10px] leading-4">
            {preview.scope.nodeIds.length > 0 ? preview.scope.nodeIds.join('、') : '未提供'}
          </p>
        </div>
      </section>

      <section className="rounded-md border border-[var(--border-primary)] bg-[var(--bg-primary)] p-3" aria-label="运行证据">
        <h3 className="text-xs font-bold">Run / NodeRun / Attempt 证据</h3>
        {preview.evidenceRefs.length > 0 ? (
          <ul className="mt-2 grid gap-2">
            {preview.evidenceRefs.map((value, index) => (
              <EvidenceRef key={`${value.runId}:${value.nodeRunId || ''}:${value.attemptId || ''}:${index}`} value={value} />
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-xs text-[var(--text-secondary)]">本次直接运行未绑定历史运行证据。</p>
        )}
      </section>

      <NoticeList kind="blocker" items={preview.blockers} />
      <NoticeList kind="warning" items={preview.warnings} />

      <section className="rounded-md border border-[var(--border-primary)] bg-[var(--bg-primary)] p-3" aria-label="预览摘要">
        <div className="flex items-center gap-2 text-xs font-bold"><Info aria-hidden="true" size={14} />预览摘要</div>
        <p className="mt-1 break-all font-mono text-[10px] leading-4">{preview.digestAlgorithm} · {preview.digest}</p>
        <p className="mt-1 text-[10px] leading-4 text-[var(--text-secondary)]">
          确认仅授权此摘要；项目、画布、revision 或节点范围变化后必须重新体检。
        </p>
      </section>
    </>
  );
}

export default function RunPreflightModal({ preview, loading, onConfirm, onCancel }: RunPreflightModalProps) {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLElement | null>(null);
  const cancelButtonRef = useRef<HTMLButtonElement | null>(null);
  const confirmButtonRef = useRef<HTMLButtonElement | null>(null);
  const onCancelRef = useRef(onCancel);
  const visible = loading || preview !== null;
  const displayedPreview = loading ? null : preview;
  const confirmDisabled = loading || !displayedPreview || displayedPreview.status === 'blocked';

  useEffect(() => {
    onCancelRef.current = onCancel;
  }, [onCancel]);

  useEffect(() => {
    if (!visible || typeof document === 'undefined') return;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = window.requestAnimationFrame(() => {
      if (!loading && preview?.status !== 'blocked') confirmButtonRef.current?.focus();
      else cancelButtonRef.current?.focus();
    });
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onCancelRef.current();
        return;
      }
      if (event.key !== 'Tab' || !dialogRef.current) return;
      const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )].filter((element) => element.getAttribute('aria-hidden') !== 'true');
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener('keydown', handleKeyDown, true);
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, [visible]);

  if (!visible || typeof document === 'undefined') return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[10100] grid place-items-center bg-black/55 p-2 sm:p-4"
      data-canvas-floating-ui="run-preflight-modal"
      data-testid="run-preflight-modal"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <section
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        aria-busy={loading}
        className="flex max-h-[min(92vh,900px)] w-full max-w-[760px] flex-col overflow-hidden rounded-lg border-2 border-[var(--border-primary)] bg-[var(--bg-secondary)] text-[var(--text-primary)] shadow-2xl"
        data-run-preflight-dialog
      >
        <header className="flex items-start gap-3 border-b border-[var(--border-primary)] px-4 py-3">
          <span className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-md bg-[var(--accent-primary)] text-white">
            {displayedPreview?.status === 'blocked' ? <ShieldX aria-hidden="true" size={18} /> : <ShieldCheck aria-hidden="true" size={18} />}
          </span>
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="text-sm font-bold">执行前只读体检</h2>
            <p id={descriptionId} className="mt-1 text-[11px] leading-4 text-[var(--text-secondary)]">
              核对当前动作、画布 revision、执行范围、历史证据与费用状态后再继续。
            </p>
          </div>
          <button
            ref={cancelButtonRef}
            type="button"
            className="grid h-8 w-8 shrink-0 place-items-center rounded border border-[var(--border-primary)] hover:bg-[var(--bg-tertiary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)]"
            aria-label="取消并关闭运行体检"
            onClick={onCancel}
          >
            <X aria-hidden="true" size={15} />
          </button>
        </header>

        <main className="min-h-0 flex-1 overflow-auto p-3 sm:p-4">
          {loading || !displayedPreview ? (
            <div className="grid min-h-64 place-items-center text-center" role="status" aria-live="polite" data-testid="run-preflight-loading">
              <div>
                <LoaderCircle aria-hidden="true" className="mx-auto animate-spin text-[var(--accent-primary)]" size={30} />
                <p className="mt-4 text-sm font-bold">正在读取执行上下文</p>
                <p className="mt-2 text-xs text-[var(--text-secondary)]">只读体检，不调用 Provider/不写 Run</p>
              </div>
            </div>
          ) : (
            <div className="grid gap-3" data-testid="run-preflight-preview">
              <PreviewDetails preview={displayedPreview} />
            </div>
          )}
        </main>

        <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--border-primary)] bg-[var(--bg-primary)] px-4 py-3">
          <p className="max-w-md text-[10px] leading-4 text-[var(--text-secondary)]">
            {displayedPreview?.status === 'blocked'
              ? '存在阻断项，不能授权执行。修正后请重新生成体检预览。'
              : '确认后仍需通过最终 revision 与画布身份校验，预览本身不会触发执行。'}
          </p>
          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              className="h-9 rounded border border-[var(--border-primary)] px-4 text-xs font-semibold hover:bg-[var(--bg-tertiary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)]"
              onClick={onCancel}
            >
              取消
            </button>
            <button
              ref={confirmButtonRef}
              type="button"
              className="inline-flex h-9 items-center gap-2 rounded bg-[var(--accent-primary)] px-4 text-xs font-bold text-white disabled:cursor-not-allowed disabled:opacity-45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg-primary)]"
              disabled={confirmDisabled}
              aria-disabled={confirmDisabled}
              onClick={() => {
                if (!confirmDisabled && displayedPreview) onConfirm(displayedPreview);
              }}
            >
              <Play aria-hidden="true" size={13} />
              {loading ? '体检中…' : displayedPreview?.status === 'blocked' ? '已阻断' : '确认并继续'}
            </button>
          </div>
        </footer>
      </section>
    </div>,
    document.body,
  );
}
