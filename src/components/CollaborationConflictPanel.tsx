import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Clipboard,
  FileText,
  RefreshCw,
  RotateCcw,
  Trash2,
  Workflow,
} from 'lucide-react';

export const COLLABORATION_CONFLICT_PANEL_MAX_ITEMS = 100;
export const COLLABORATION_CONFLICT_PREVIEW_MAX_CODEPOINTS = 800;

export type CollaborationConflictReason =
  | 'deleted'
  | 'binding_epoch'
  | 'schema'
  | 'revision'
  | 'permission'
  | 'offline';

export interface CollaborationConflictTarget {
  entityType: string;
  entityUid: string;
  displayId?: string;
  label?: string;
}

interface CollaborationConflictBase {
  id: string;
  reason: CollaborationConflictReason;
  target: CollaborationConflictTarget;
  createdAt: number;
}

export interface CollaborationTextConflictItem extends CollaborationConflictBase {
  kind: 'text';
  field: string;
  localText: string;
}

export interface CollaborationStructureConflictItem extends CollaborationConflictBase {
  kind: 'structure';
  field?: string;
  /** Only true when the authority has supplied an explicit tombstone-bound restore path. */
  canExplicitRestore: boolean;
}

export type CollaborationConflictItem =
  | CollaborationTextConflictItem
  | CollaborationStructureConflictItem;

export type CollaborationConflictAction = 'copy' | 'discard' | 'resync' | 'restore';

export interface CollaborationConflictPanelProps {
  /**
   * The caller owns this memory-only collection. This component deliberately has no
   * browser persistence adapter and never serializes recovery contents.
   */
  items: readonly CollaborationConflictItem[];
  onCopyText: (item: CollaborationTextConflictItem, exactText: string) => void | Promise<void>;
  onDiscardText: (item: CollaborationTextConflictItem) => void | Promise<void>;
  onResyncStructure: (item: CollaborationStructureConflictItem) => void | Promise<void>;
  onExplicitRestoreStructure: (item: CollaborationStructureConflictItem) => void | Promise<void>;
  onActionError?: (
    error: unknown,
    item: CollaborationConflictItem,
    action: CollaborationConflictAction,
  ) => void;
  autoFocusOnFirstConflict?: boolean;
  className?: string;
}

const CONFLICT_REASONS: Readonly<Record<CollaborationConflictReason, {
  label: string;
  description: string;
}>> = {
  deleted: {
    label: '对象已删除',
    description: '权威对象已经删除，陈旧修改不会自动把它复活。',
  },
  binding_epoch: {
    label: '编辑绑定已更换',
    description: '对象生命周期或文本绑定已经变化，本地内容不能写回旧绑定。',
  },
  schema: {
    label: 'Schema 不兼容',
    description: '本地操作使用了当前主机不再接受的结构或字段协议。',
  },
  revision: {
    label: 'Revision 冲突',
    description: '权威版本已经前进，本地操作不能按旧 revision 安全提交。',
  },
  permission: {
    label: '权限已变化',
    description: '当前会话已不再具备提交这项修改所需的能力。',
  },
  offline: {
    label: '离线操作被阻止',
    description: '此类修改不允许进入离线队列，恢复在线后必须重新同步。',
  },
};

const CONFLICT_REASON_SET = new Set<CollaborationConflictReason>(
  Object.keys(CONFLICT_REASONS) as CollaborationConflictReason[],
);

export function collaborationConflictReasonLabel(reason: CollaborationConflictReason) {
  return CONFLICT_REASONS[reason].label;
}

export function collaborationConflictActions(
  item: CollaborationConflictItem,
): readonly CollaborationConflictAction[] {
  return item.kind === 'text'
    ? ['copy', 'discard'] as const
    : ['resync', 'restore'] as const;
}

export function truncateCollaborationConflictPreview(
  text: string,
  maxCodepoints = COLLABORATION_CONFLICT_PREVIEW_MAX_CODEPOINTS,
) {
  const normalizedLimit = Number.isSafeInteger(maxCodepoints) && maxCodepoints > 0
    ? maxCodepoints
    : COLLABORATION_CONFLICT_PREVIEW_MAX_CODEPOINTS;
  const codepoints = Array.from(String(text));
  if (codepoints.length <= normalizedLimit) {
    return { text: codepoints.join(''), truncated: false, totalCodepoints: codepoints.length };
  }
  return {
    text: `${codepoints.slice(0, normalizedLimit).join('')}\u2026`,
    truncated: true,
    totalCodepoints: codepoints.length,
  };
}

function isBoundedIdentifier(value: unknown, maxLength = 240): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= maxLength
    && value.trim() === value
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function validConflictItem(item: unknown): item is CollaborationConflictItem {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
  const value = item as Partial<CollaborationConflictItem>;
  if (!isBoundedIdentifier(value.id)
    || !CONFLICT_REASON_SET.has(value.reason as CollaborationConflictReason)
    || !Number.isSafeInteger(value.createdAt)
    || Number(value.createdAt) < 0
    || !value.target
    || !isBoundedIdentifier(value.target.entityType, 100)
    || !isBoundedIdentifier(value.target.entityUid)) return false;
  if (value.target.displayId != null && !isBoundedIdentifier(value.target.displayId)) return false;
  if (value.target.label != null
    && (typeof value.target.label !== 'string' || value.target.label.length > 500)) return false;
  if (value.kind === 'text') {
    return isBoundedIdentifier(value.field, 100) && typeof value.localText === 'string';
  }
  return value.kind === 'structure'
    && (value.field == null || isBoundedIdentifier(value.field, 100))
    && typeof value.canExplicitRestore === 'boolean';
}

export function visibleCollaborationConflictItems(
  items: readonly CollaborationConflictItem[],
) {
  const visible: CollaborationConflictItem[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (visible.length >= COLLABORATION_CONFLICT_PANEL_MAX_ITEMS) break;
    if (!validConflictItem(item) || seen.has(item.id)) continue;
    seen.add(item.id);
    visible.push(item);
  }
  return visible;
}

function boundedDisplay(value: string | undefined, fallback: string, maxCodepoints = 120) {
  const candidate = String(value || '').trim() || fallback;
  return truncateCollaborationConflictPreview(candidate, maxCodepoints).text;
}

function actionSuccessMessage(action: CollaborationConflictAction) {
  if (action === 'copy') return '本地文本已交给复制处理器；权威对象没有被修改。';
  if (action === 'discard') return '本地文本恢复项已交给丢弃处理器。';
  if (action === 'resync') return '结构冲突已请求重新同步。';
  return '显式恢复请求已提交；仍需通过主机权威校验。';
}

export default function CollaborationConflictPanel({
  items,
  onCopyText,
  onDiscardText,
  onResyncStructure,
  onExplicitRestoreStructure,
  onActionError,
  autoFocusOnFirstConflict = true,
  className = '',
}: CollaborationConflictPanelProps) {
  const titleId = useId();
  const descriptionId = useId();
  const visibleItems = useMemo(() => visibleCollaborationConflictItems(items), [items]);
  const visibleIds = useMemo(() => visibleItems.map((item) => item.id), [visibleItems]);
  const visibleIdsKey = visibleIds.join('\u0001');
  const panelRef = useRef<HTMLElement | null>(null);
  const emptyStateRef = useRef<HTMLParagraphElement | null>(null);
  const itemRefs = useRef(new Map<string, HTMLElement>());
  const previousVisibleIdsRef = useRef<string[]>([]);
  const focusAfterRemovalRef = useRef<{ id: string; index: number } | null>(null);
  const [pendingAction, setPendingAction] = useState('');
  const [announcement, setAnnouncement] = useState('');
  const [expandedTextIds, setExpandedTextIds] = useState<ReadonlySet<string>>(() => new Set());

  const setTextExpanded = useCallback((id: string, expanded: boolean) => {
    setExpandedTextIds((current) => {
      if (expanded === current.has(id)) return current;
      const next = new Set(current);
      if (expanded) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const focusItemAt = useCallback((index: number) => {
    if (!visibleItems.length) {
      emptyStateRef.current?.focus();
      return;
    }
    const boundedIndex = Math.max(0, Math.min(index, visibleItems.length - 1));
    itemRefs.current.get(visibleItems[boundedIndex].id)?.focus();
  }, [visibleItems]);

  useEffect(() => {
    const previousIds = previousVisibleIdsRef.current;
    const focusAfterRemoval = focusAfterRemovalRef.current;
    const removedInvokedItem = focusAfterRemoval && !visibleIds.includes(focusAfterRemoval.id);
    if (removedInvokedItem) {
      focusAfterRemovalRef.current = null;
      const frame = window.requestAnimationFrame(() => focusItemAt(focusAfterRemoval.index));
      previousVisibleIdsRef.current = visibleIds;
      return () => window.cancelAnimationFrame(frame);
    }

    const firstArrival = previousIds.length === 0 && visibleIds.length > 0;
    previousVisibleIdsRef.current = visibleIds;
    if (!autoFocusOnFirstConflict || !firstArrival) return;
    const frame = window.requestAnimationFrame(() => focusItemAt(0));
    return () => window.cancelAnimationFrame(frame);
  }, [autoFocusOnFirstConflict, focusItemAt, visibleIdsKey]);

  const runAction = useCallback(async (
    item: CollaborationConflictItem,
    index: number,
    action: CollaborationConflictAction,
  ) => {
    const allowedActions = collaborationConflictActions(item);
    if (!allowedActions.includes(action) || pendingAction) return;
    if (action === 'restore' && (item.kind !== 'structure' || !item.canExplicitRestore)) return;
    const actionKey = `${item.id}:${action}`;
    focusAfterRemovalRef.current = { id: item.id, index };
    setPendingAction(actionKey);
    setAnnouncement('');
    try {
      if (item.kind === 'text') {
        if (action === 'copy') await onCopyText(item, item.localText);
        else if (action === 'discard') await onDiscardText(item);
      } else if (action === 'resync') {
        await onResyncStructure(item);
      } else if (action === 'restore') {
        await onExplicitRestoreStructure(item);
      }
      setTextExpanded(item.id, false);
      setAnnouncement(actionSuccessMessage(action));
    } catch (error) {
      focusAfterRemovalRef.current = null;
      setAnnouncement('冲突处理失败，恢复内容仍保留在本页内存中；可展开完整正文并手工选择复制。');
      onActionError?.(error, item, action);
    } finally {
      setPendingAction('');
    }
  }, [
    onActionError,
    onCopyText,
    onDiscardText,
    onExplicitRestoreStructure,
    onResyncStructure,
    pendingAction,
    setTextExpanded,
  ]);

  return (
    <section
      ref={panelRef}
      className={`rounded border border-amber-500/50 bg-amber-500/10 p-3 text-[var(--text-primary)] ${className}`.trim()}
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      data-testid="collaboration-conflict-panel"
      data-memory-only-recovery="true"
    >
      <header className="flex items-start gap-2">
        <AlertTriangle aria-hidden="true" className="mt-0.5 shrink-0 text-amber-600" size={15} />
        <div className="min-w-0 flex-1">
          <h3 id={titleId} className="text-xs font-bold">协作冲突恢复</h3>
          <p id={descriptionId} className="mt-1 text-[10px] leading-4 text-[var(--text-secondary)]">
            恢复内容只保留在当前页面内存中。文本只能复制或丢弃；结构必须重新同步或显式恢复，绝不会自动复活对象。
          </p>
        </div>
        <span className="shrink-0 rounded border border-amber-500/40 px-2 py-1 text-[9px] font-bold">
          {visibleItems.length}/{items.length}
        </span>
      </header>

      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {announcement || `当前有 ${visibleItems.length} 条协作冲突`}
      </p>

      {visibleItems.length === 0 ? (
        <p
          ref={emptyStateRef}
          tabIndex={-1}
          role="status"
          aria-live="polite"
          className="mt-3 rounded border border-[var(--border-primary)] bg-[var(--bg-secondary)] px-3 py-4 text-center text-[10px] text-[var(--text-secondary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)]"
          data-testid="collaboration-conflict-empty"
        >
          没有需要处理的协作冲突
        </p>
      ) : (
        <div className="mt-3 space-y-2" role="list" aria-label="待处理协作冲突">
          {visibleItems.map((item, index) => {
            const reason = CONFLICT_REASONS[item.reason];
            const targetName = boundedDisplay(
              item.target.label,
              `${item.target.entityType} · ${item.target.displayId || item.target.entityUid}`,
            );
            const preview = item.kind === 'text'
              ? truncateCollaborationConflictPreview(item.localText)
              : null;
            const copyPending = pendingAction === `${item.id}:copy`;
            const discardPending = pendingAction === `${item.id}:discard`;
            const resyncPending = pendingAction === `${item.id}:resync`;
            const restorePending = pendingAction === `${item.id}:restore`;
            const anyPending = Boolean(pendingAction);
            return (
              <article
                key={item.id}
                ref={(element) => {
                  if (element) itemRefs.current.set(item.id, element);
                  else itemRefs.current.delete(item.id);
                }}
                role="listitem"
                tabIndex={-1}
                data-conflict-kind={item.kind}
                data-conflict-reason={item.reason}
                className="rounded border border-[var(--border-primary)] bg-[var(--bg-secondary)] p-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)]"
                onKeyDown={(event) => {
                  if (event.target !== event.currentTarget) return;
                  if (event.key === 'ArrowDown') {
                    event.preventDefault();
                    focusItemAt(index + 1);
                  } else if (event.key === 'ArrowUp') {
                    event.preventDefault();
                    focusItemAt(index - 1);
                  } else if (event.key === 'Home') {
                    event.preventDefault();
                    focusItemAt(0);
                  } else if (event.key === 'End') {
                    event.preventDefault();
                    focusItemAt(visibleItems.length - 1);
                  }
                }}
              >
                <div className="flex items-start gap-2">
                  <span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded bg-amber-500/15 text-amber-600">
                    {item.kind === 'text'
                      ? <FileText aria-hidden="true" size={13} />
                      : <Workflow aria-hidden="true" size={13} />}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <strong className="text-[11px]">{item.kind === 'text' ? '文本冲突' : '结构冲突'}</strong>
                      <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[9px] font-semibold text-amber-700">
                        {reason.label}
                      </span>
                    </div>
                    <p className="mt-1 truncate text-[10px] font-semibold" title={targetName}>目标：{targetName}</p>
                    <p className="mt-1 break-all font-mono text-[9px] text-[var(--text-secondary)]">
                      entityUid: {item.target.entityUid}
                    </p>
                    <p className="mt-1 text-[10px] text-[var(--text-secondary)]">
                      字段：{boundedDisplay(item.field, item.kind === 'text' ? '未知文本字段' : '结构')}
                    </p>
                    <p className="mt-1 text-[10px] leading-4 text-[var(--text-secondary)]">原因：{reason.description}</p>
                  </div>
                </div>

                {item.kind === 'text' && preview && (
                  <div className="mt-3 rounded border border-[var(--border-primary)] bg-[var(--bg-primary)] p-2">
                    <div className="flex items-center justify-between gap-2 text-[9px] font-semibold text-[var(--text-secondary)]">
                      <span>本地文本预览</span>
                      <span>{preview.totalCodepoints} 字符{preview.truncated ? ` · 仅显示前 ${COLLABORATION_CONFLICT_PREVIEW_MAX_CODEPOINTS}` : ''}</span>
                    </div>
                    <pre className="mt-2 max-h-36 overflow-auto whitespace-pre-wrap break-words font-sans text-[10px] leading-4" data-testid="collaboration-conflict-text-preview">
                      {preview.text || '（本地文本为空）'}
                    </pre>
                    <details
                      className="mt-2 border-t border-[var(--border-primary)] pt-2"
                      data-testid="collaboration-conflict-full-text-disclosure"
                      onToggle={(event) => setTextExpanded(item.id, event.currentTarget.open)}
                    >
                      <summary className="cursor-pointer select-none text-[10px] font-bold text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)]">
                        展开完整正文并手工复制
                      </summary>
                      {expandedTextIds.has(item.id) && (
                        <div className="mt-2">
                          <p className="mb-2 text-[9px] leading-4 text-[var(--text-secondary)]">
                            自动复制不可用时，请在下方正文中全选并复制；内容仍只保留在当前页面内存中。
                          </p>
                          <textarea
                            readOnly
                            spellCheck={false}
                            value={item.localText}
                            rows={8}
                            aria-label={`完整恢复正文：${targetName}`}
                            data-testid="collaboration-conflict-full-text"
                            className="max-h-64 w-full resize-y select-text whitespace-pre rounded border border-[var(--border-primary)] bg-[var(--bg-secondary)] p-2 font-mono text-[10px] leading-4"
                            onFocus={(event) => event.currentTarget.select()}
                          />
                        </div>
                      )}
                    </details>
                  </div>
                )}

                <div className="mt-3 flex flex-wrap gap-2" aria-label={`${item.kind === 'text' ? '文本' : '结构'}冲突操作`}>
                  {item.kind === 'text' ? (
                    <>
                      <button
                        type="button"
                        className="flex h-8 flex-1 items-center justify-center gap-1 rounded border border-[var(--border-primary)] px-2 text-[10px] font-bold disabled:opacity-40"
                        disabled={anyPending}
                        aria-label={`复制 ${targetName} 的本地文本内容`}
                        onClick={() => void runAction(item, index, 'copy')}
                      >
                        <Clipboard aria-hidden="true" size={12} />{copyPending ? '复制中…' : '复制内容'}
                      </button>
                      <button
                        type="button"
                        className="flex h-8 flex-1 items-center justify-center gap-1 rounded border border-red-500/50 px-2 text-[10px] font-bold text-red-500 disabled:opacity-40"
                        disabled={anyPending}
                        aria-label={`丢弃 ${targetName} 的本地文本恢复内容`}
                        onClick={() => void runAction(item, index, 'discard')}
                      >
                        <Trash2 aria-hidden="true" size={12} />{discardPending ? '丢弃中…' : '丢弃'}
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="flex h-8 flex-1 items-center justify-center gap-1 rounded border border-[var(--border-primary)] px-2 text-[10px] font-bold disabled:opacity-40"
                        disabled={anyPending}
                        aria-label={`重新同步 ${targetName}`}
                        onClick={() => void runAction(item, index, 'resync')}
                      >
                        <RefreshCw aria-hidden="true" size={12} />{resyncPending ? '同步中…' : '重新同步'}
                      </button>
                      <button
                        type="button"
                        className="flex h-8 flex-1 items-center justify-center gap-1 rounded border border-amber-500/60 px-2 text-[10px] font-bold text-amber-700 disabled:opacity-40"
                        disabled={anyPending || !item.canExplicitRestore}
                        aria-disabled={anyPending || !item.canExplicitRestore}
                        title={item.canExplicitRestore ? '提交显式恢复请求，主机仍会校验 tombstone 身份' : '缺少可验证的 tombstone 恢复身份'}
                        aria-label={`显式恢复 ${targetName}`}
                        onClick={() => void runAction(item, index, 'restore')}
                      >
                        <RotateCcw aria-hidden="true" size={12} />{restorePending ? '恢复中…' : '显式恢复'}
                      </button>
                    </>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}

      {items.length > visibleItems.length && (
        <p className="mt-2 text-[9px] leading-4 text-[var(--text-secondary)]" role="status">
          为保证面板响应，只显示前 {COLLABORATION_CONFLICT_PANEL_MAX_ITEMS} 条有效且不重复的冲突；其余内容仍由调用方保留在内存中。
        </p>
      )}
    </section>
  );
}
