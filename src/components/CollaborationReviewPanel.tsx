import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import {
  Bell,
  ChevronLeft,
  ChevronRight,
  Download,
  GitCompare,
  MessageSquare,
  Paperclip,
  RefreshCw,
  Reply,
  Send,
  ShieldAlert,
  X,
} from 'lucide-react';
import type {
  CollaborationReviewAnchorInput,
  CollaborationReviewAsset,
  CollaborationReviewComment,
  CollaborationReviewCompareResult,
  CollaborationReviewComparison,
  CollaborationReviewMember,
  CollaborationReviewNotification,
  CollaborationReviewPageMeta,
  CollaborationReviewReferenceInput,
  CollaborationReviewLifecycleStatus,
  CollaborationReviewResolutionStatus,
  CollaborationReviewSeverity,
  CollaborationReviewThread,
} from '../types/project';
import {
  canPerformCollaborationReviewLifecycleAction,
  canReassertCollaborationReviewDecision,
  collaborationReviewLifecycleActionTarget,
  oppositeCollaborationReviewResolutionStatus,
} from '../utils/reviewLifecycle';

export interface CollaborationReviewApiEnvelope<T> {
  data: T;
  meta?: CollaborationReviewPageMeta | Record<string, unknown>;
}

export type CollaborationReviewRequest = <T>(
  url: string,
  init?: RequestInit,
) => Promise<CollaborationReviewApiEnvelope<T>>;

interface AnchorEntityOption {
  id: string;
  entityUid?: string;
  data?: Record<string, unknown>;
}

interface ReviewTextEditorState {
  entityUid: string;
  text: string;
  canUndo: boolean;
  canRedo: boolean;
}

interface CollaborationReviewPanelProps {
  canvasId: string;
  canvasRevision: number;
  memberId: string;
  online: boolean;
  canComment: boolean;
  canApprove: boolean;
  nodes: AnchorEntityOption[];
  edges: AnchorEntityOption[];
  selectedNodeId?: string;
  selectedEdgeId?: string;
  threads: CollaborationReviewThread[];
  refreshToken: number;
  request: CollaborationReviewRequest;
  onThreadsChange: (threads: CollaborationReviewThread[]) => void;
  onStatus: (message: string) => void;
  onSelectNode?: (nodeId: string) => void;
  textEditor?: ReviewTextEditorState | null;
  onOpenCommentEditor?: (comment: CollaborationReviewComment) => void | Promise<void>;
  onCloseCommentEditor?: () => void;
  onChangeCommentEditor?: (value: string) => void;
  onUndoCommentEditor?: () => void;
  onRedoCommentEditor?: () => void;
}

type AnchorKind = CollaborationReviewAnchorInput['kind'];

interface ReviewFilters {
  reviewStatus: '' | CollaborationReviewLifecycleStatus;
  severity: '' | CollaborationReviewSeverity;
  anchorKind: '' | AnchorKind;
  memberId: string;
  unresolved: boolean;
  approvalExpired: boolean;
}

interface ReferenceDraft {
  mentions: string[];
  assetUids: string[];
}

interface ReplyDraft extends ReferenceDraft {
  threadId: string;
  parentId?: string;
  body: string;
}

const EMPTY_FILTERS: ReviewFilters = {
  reviewStatus: '',
  severity: '',
  anchorKind: '',
  memberId: '',
  unresolved: false,
  approvalExpired: false,
};

const SEVERITY_LABELS: Record<CollaborationReviewSeverity, string> = {
  low: '低',
  normal: '普通',
  high: '高',
  blocking: '阻断',
};

const REVIEW_STATUS_LABELS: Record<CollaborationReviewLifecycleStatus | 'expired', string> = {
  draft: '草稿',
  in_review: '审片中',
  changes_requested: '请求修改',
  approved: '已批准',
  expired: '审批已过期',
};

const RESOLUTION_STATUS_LABELS: Record<CollaborationReviewResolutionStatus, string> = {
  open: '未解决',
  resolved: '已解决',
};

const ANCHOR_LABELS: Record<AnchorKind, string> = {
  canvas: '画布坐标',
  node: '节点',
  edge: '连线',
  asset: '素材',
  video: '视频帧',
};

function finiteInteger(value: unknown, fallback = 0) {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) ? numeric : fallback;
}

function safeMemberId(value: unknown) {
  return String(value || '').trim().toLowerCase();
}

function uniqueLimited(values: string[], limit = 20) {
  return [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))].slice(0, limit);
}

function normalizeMembers(raw: unknown): CollaborationReviewMember[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const result: CollaborationReviewMember[] = [];
  for (const item of raw.slice(0, 1000)) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const memberId = safeMemberId(record.memberId || record.id);
    if (!memberId || seen.has(memberId)) continue;
    seen.add(memberId);
    result.push({
      memberId,
      displayName: String(record.displayName || '协作者').slice(0, 240),
      role: ['owner', 'editor', 'reviewer', 'viewer'].includes(String(record.role))
        ? record.role as CollaborationReviewMember['role']
        : null,
    });
  }
  return result;
}

function normalizeAssets(raw: unknown): CollaborationReviewAsset[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 1000).filter((item): item is CollaborationReviewAsset => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
    const record = item as Record<string, unknown>;
    return Boolean(record.id && record.entityUid && record.filename);
  });
}

function reviewQuery(canvasId: string, filters: ReviewFilters) {
  const query = new URLSearchParams({ canvasId, limit: '100', offset: '0' });
  if (filters.reviewStatus) query.set('reviewStatus', filters.reviewStatus);
  if (filters.severity) query.set('severity', filters.severity);
  if (filters.anchorKind) query.set('anchorKind', filters.anchorKind);
  if (filters.memberId) query.set('createdBy', filters.memberId);
  if (filters.unresolved) query.set('unresolved', 'true');
  if (filters.approvalExpired) query.set('approvalExpired', 'true');
  return query;
}

function reviewReferenceInputs(assetUids: string[], assets: CollaborationReviewAsset[]) {
  const byUid = new Map(assets.map((asset) => [safeMemberId(asset.entityUid), asset]));
  return uniqueLimited(assetUids).map((assetUid): CollaborationReviewReferenceInput | null => {
    const asset = byUid.get(safeMemberId(assetUid));
    const assetContentRevision = finiteInteger(asset?.contentRevision, 0);
    const contentHash = String(asset?.contentHash || '').toLowerCase();
    if (!asset || assetContentRevision < 1 || !/^[a-f0-9]{64}$/.test(contentHash)) return null;
    return { assetUid: asset.entityUid, assetContentRevision, contentHash };
  }).filter((item): item is CollaborationReviewReferenceInput => Boolean(item));
}

function anchorDisplay(thread: CollaborationReviewThread, nodes: AnchorEntityOption[], edges: AnchorEntityOption[]) {
  const anchor = thread.anchor;
  if (anchor.kind === 'canvas') return `画布 (${Math.round(anchor.x)}, ${Math.round(anchor.y)})`;
  if (anchor.unavailable) return `${ANCHOR_LABELS[anchor.kind]} · 已不可用`;
  const targetUid = String(anchor.targetEntityUid || '');
  if (anchor.kind === 'node') {
    const target = nodes.find((node) => node.entityUid === targetUid);
    return `节点 · ${String(target?.data?.title || target?.data?.label || target?.id || targetUid).slice(0, 80)}`;
  }
  if (anchor.kind === 'edge') {
    const target = edges.find((edge) => edge.entityUid === targetUid);
    return `连线 · ${target?.id || targetUid}`;
  }
  if (anchor.kind === 'video') {
    const filename = anchor.asset?.filename || targetUid || '受限素材';
    return `视频 · ${filename} · ${(anchor.frameMs / 1000).toFixed(3)}s`;
  }
  if (anchor.kind === 'asset') return `素材 · ${anchor.asset?.filename || targetUid || '受限素材'}`;
  return ANCHOR_LABELS[anchor.kind];
}

function safeComparisonLines(comparison: CollaborationReviewComparison) {
  const lines = [`revision ${comparison.fromRevision ?? '?'} → ${comparison.toRevision ?? '?'}`];
  const appendCollection = (
    label: string,
    collection: CollaborationReviewComparison['nodes'],
  ) => {
    lines.push(`${label}：新增 ${collection.counts.added} · 删除 ${collection.counts.removed} · 修改 ${collection.counts.changed}`);
    const groups: Array<[string, string[]]> = [
      ['新增', collection.added],
      ['删除', collection.removed],
      ['修改', collection.changed],
    ];
    for (const [changeLabel, entityUids] of groups) {
      for (const entityUid of entityUids.slice(0, 100)) {
        const visibleUid = String(entityUid).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 160);
        if (visibleUid) lines.push(`${label}${changeLabel} · ${visibleUid}`);
      }
    }
    if (collection.truncated) lines.push(`${label}对比结果已按安全上限截断`);
  };
  appendCollection('节点', comparison.nodes);
  appendCollection('连线', comparison.edges);
  if (comparison.viewportChanged) lines.push('画布视口已变化');
  return lines;
}

function timestampLabel(value: number | null | undefined) {
  if (!Number.isFinite(Number(value))) return '';
  try { return new Date(Number(value)).toLocaleString(); } catch { return ''; }
}

function ReferencePicker({
  members,
  assets,
  value,
  disabled,
  onChange,
}: {
  members: CollaborationReviewMember[];
  assets: CollaborationReviewAsset[];
  value: ReferenceDraft;
  disabled: boolean;
  onChange: (value: ReferenceDraft) => void;
}) {
  const pinnableAssets = assets.filter((asset) => (
    finiteInteger(asset.contentRevision, 0) > 0 && /^[a-f0-9]{64}$/i.test(String(asset.contentHash || ''))
  ));
  const toggle = (field: keyof ReferenceDraft, item: string, checked: boolean) => {
    const current = value[field];
    const next = checked ? uniqueLimited([...current, item]) : current.filter((candidate) => candidate !== item);
    onChange({ ...value, [field]: next });
  };
  return (
    <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2" data-testid="collaboration-review-references">
      <details className="rounded border border-[var(--border-primary)] p-2">
        <summary className="cursor-pointer text-[10px] font-bold">@成员 ({value.mentions.length}/20)</summary>
        <div className="mt-2 max-h-32 space-y-1 overflow-auto">
          {members.map((member) => (
            <label key={member.memberId} className="flex items-center gap-2 text-[10px]">
              <input type="checkbox" disabled={disabled} checked={value.mentions.includes(member.memberId)} onChange={(event) => toggle('mentions', member.memberId, event.target.checked)} />
              <span className="min-w-0 flex-1 truncate">@{member.displayName}</span><span className="opacity-50">{member.role || '离开'}</span>
            </label>
          ))}
          {!members.length && <div className="text-[10px] opacity-55">没有可提及成员</div>}
        </div>
      </details>
      <details className="rounded border border-[var(--border-primary)] p-2">
        <summary className="cursor-pointer text-[10px] font-bold">授权附件 ({value.assetUids.length}/20)</summary>
        <div className="mt-2 max-h-32 space-y-1 overflow-auto">
          {pinnableAssets.map((asset) => (
            <label key={asset.entityUid} className="flex items-center gap-2 text-[10px]">
              <input type="checkbox" disabled={disabled} checked={value.assetUids.includes(asset.entityUid)} onChange={(event) => toggle('assetUids', asset.entityUid, event.target.checked)} />
              <Paperclip size={10} className="shrink-0" /><span className="min-w-0 flex-1 truncate">{asset.filename}</span><span className="opacity-50">r{asset.contentRevision}</span>
            </label>
          ))}
          {!pinnableAssets.length && <div className="text-[10px] opacity-55">没有带内容凭据的授权素材</div>}
        </div>
      </details>
    </div>
  );
}

export default function CollaborationReviewPanel({
  canvasId,
  canvasRevision,
  memberId,
  online,
  canComment,
  canApprove,
  nodes,
  edges,
  selectedNodeId = '',
  selectedEdgeId = '',
  threads,
  refreshToken,
  request,
  onThreadsChange,
  onStatus,
  onSelectNode,
  textEditor = null,
  onOpenCommentEditor,
  onCloseCommentEditor,
  onChangeCommentEditor,
  onUndoCommentEditor,
  onRedoCommentEditor,
}: CollaborationReviewPanelProps) {
  const [members, setMembers] = useState<CollaborationReviewMember[]>([]);
  const [assets, setAssets] = useState<CollaborationReviewAsset[]>([]);
  const [notifications, setNotifications] = useState<CollaborationReviewNotification[]>([]);
  const [filters, setFilters] = useState<ReviewFilters>(EMPTY_FILTERS);
  const [total, setTotal] = useState(0);
  const [selectedThreadId, setSelectedThreadId] = useState('');
  const [loading, setLoading] = useState(false);
  const [mutating, setMutating] = useState(false);
  const [anchorKind, setAnchorKind] = useState<AnchorKind>('canvas');
  const [anchorTargetUid, setAnchorTargetUid] = useState('');
  const [canvasX, setCanvasX] = useState('0');
  const [canvasY, setCanvasY] = useState('0');
  const [frameMs, setFrameMs] = useState('0');
  const [body, setBody] = useState('');
  const [severity, setSeverity] = useState<CollaborationReviewSeverity>('normal');
  const [references, setReferences] = useState<ReferenceDraft>({ mentions: [], assetUids: [] });
  const [replyDraft, setReplyDraft] = useState<ReplyDraft | null>(null);
  const [comparison, setComparison] = useState<CollaborationReviewComparison | null>(null);
  const [showNotifications, setShowNotifications] = useState(false);
  const requestGeneration = useRef(0);

  const memberById = useMemo(() => new Map(members.map((member) => [member.memberId, member])), [members]);
  const assetByUid = useMemo(() => new Map(assets.map((asset) => [asset.entityUid, asset])), [assets]);
  const selectedThread = threads.find((thread) => thread.id === selectedThreadId) || null;
  const selectedIndex = selectedThread ? threads.findIndex((thread) => thread.id === selectedThread.id) : -1;
  const selectedNode = nodes.find((node) => node.id === selectedNodeId);
  const selectedEdge = edges.find((edge) => edge.id === selectedEdgeId);
  const unreadCount = notifications.filter((item) => item.readAt == null).length;

  const loadReviews = useCallback(async () => {
    if (!canvasId) return;
    const generation = ++requestGeneration.current;
    setLoading(true);
    try {
      const response = await request<CollaborationReviewThread[]>(
        `/api/collab/reviews?${reviewQuery(canvasId, filters)}`,
      );
      if (generation !== requestGeneration.current) return;
      const next = Array.isArray(response.data) ? response.data : [];
      onThreadsChange(next);
      const nextTotal = Number((response.meta as CollaborationReviewPageMeta | undefined)?.total);
      setTotal(Number.isSafeInteger(nextTotal) && nextTotal >= 0 ? nextTotal : next.length);
      setSelectedThreadId((current) => next.some((thread) => thread.id === current)
        ? current
        : next[0]?.id || '');
    } catch (error) {
      if (generation === requestGeneration.current) onStatus(error instanceof Error ? error.message : String(error));
    } finally {
      if (generation === requestGeneration.current) setLoading(false);
    }
  }, [canvasId, filters, onStatus, onThreadsChange, request]);

  const loadNotifications = useCallback(async () => {
    if (!canvasId) return;
    try {
      const response = await request<CollaborationReviewNotification[]>(
        `/api/collab/notifications?canvasId=${encodeURIComponent(canvasId)}&limit=50&offset=0`,
      );
      setNotifications(Array.isArray(response.data) ? response.data : []);
    } catch (error) {
      onStatus(error instanceof Error ? error.message : String(error));
    }
  }, [canvasId, onStatus, request]);

  useEffect(() => {
    if (!canvasId) return undefined;
    let active = true;
    void Promise.all([
      request<unknown[]>('/api/collab/members'),
      request<unknown[]>('/api/collab/assets?limit=100&offset=0'),
    ]).then(([memberResponse, assetResponse]) => {
      if (!active) return;
      setMembers(normalizeMembers(memberResponse.data));
      setAssets(normalizeAssets(assetResponse.data));
    }).catch((error) => {
      if (active) onStatus(error instanceof Error ? error.message : String(error));
    });
    return () => { active = false; };
  }, [canvasId, onStatus, request]);

  useEffect(() => { void loadReviews(); }, [loadReviews, refreshToken]);
  useEffect(() => { void loadNotifications(); }, [loadNotifications, refreshToken]);

  useEffect(() => {
    if (!anchorTargetUid && selectedNode?.entityUid && anchorKind === 'node') {
      setAnchorTargetUid(selectedNode.entityUid);
    }
  }, [anchorKind, anchorTargetUid, selectedNode?.entityUid]);

  const makeAnchor = (): CollaborationReviewAnchorInput => {
    if (anchorKind === 'canvas') {
      const x = Number(canvasX);
      const y = Number(canvasY);
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('画布锚点坐标无效');
      return { kind: 'canvas', x, y };
    }
    const targetUid = String(anchorTargetUid || (
      anchorKind === 'node' ? selectedNode?.entityUid : anchorKind === 'edge' ? selectedEdge?.entityUid : ''
    ) || '');
    if (!targetUid) throw new Error(`请选择${ANCHOR_LABELS[anchorKind]}锚点`);
    if (anchorKind !== 'video') return { kind: anchorKind, targetUid };
    const asset = assetByUid.get(targetUid);
    const pinnedRevision = finiteInteger(asset?.contentRevision, 0);
    const pinnedHash = String(asset?.contentHash || '').toLowerCase();
    const exactFrameMs = finiteInteger(frameMs, -1);
    if (!asset || asset.kind !== 'video' || pinnedRevision < 1 || !/^[a-f0-9]{64}$/.test(pinnedHash)) {
      throw new Error('视频锚点必须选择带内容 revision/hash 的授权视频');
    }
    if (exactFrameMs < 0) throw new Error('视频时间码必须是非负整数毫秒');
    return {
      kind: 'video',
      targetUid,
      frameMs: exactFrameMs,
      assetContentRevision: pinnedRevision,
      contentHash: pinnedHash,
    };
  };

  const mutate = async (operation: () => Promise<unknown>, success: string) => {
    setMutating(true);
    try {
      await operation();
      onStatus(success);
      await Promise.all([loadReviews(), loadNotifications()]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      onStatus(message);
      await loadReviews();
    } finally {
      setMutating(false);
    }
  };

  const submitThread = async () => {
    const trimmed = body.trim();
    if (!online || !canComment || !trimmed || !canvasId) return;
    let anchor: CollaborationReviewAnchorInput;
    try { anchor = makeAnchor(); } catch (error) {
      onStatus(error instanceof Error ? error.message : String(error));
      return;
    }
    const expectedCanvasRevision = canvasRevision;
    const attachments = reviewReferenceInputs(references.assetUids, assets);
    await mutate(async () => {
      await request('/api/collab/reviews', {
        method: 'POST',
        body: JSON.stringify({
          canvasId,
          expectedCanvasRevision,
          anchor,
          body: trimmed,
          severity,
          reviewStatus: 'draft',
          mentions: uniqueLimited(references.mentions),
          attachments,
        }),
      });
      setBody('');
      setReferences({ mentions: [], assetUids: [] });
    }, `审片草稿已保存到 revision ${expectedCanvasRevision}`);
  };

  const submitReply = async (thread: CollaborationReviewThread) => {
    if (!replyDraft || replyDraft.threadId !== thread.id || !replyDraft.body.trim()) return;
    const expectedCanvasRevision = canvasRevision;
    const expectedThreadRevision = thread.revision;
    const draft = replyDraft;
    await mutate(async () => {
      await request(`/api/collab/reviews/${encodeURIComponent(thread.id)}/comments`, {
        method: 'POST',
        body: JSON.stringify({
          body: draft.body.trim(),
          ...(draft.parentId ? { parentId: draft.parentId } : {}),
          expectedCanvasRevision,
          expectedThreadRevision,
          mentions: uniqueLimited(draft.mentions),
          attachments: reviewReferenceInputs(draft.assetUids, assets),
        }),
      });
      setReplyDraft(null);
    }, `回复已提交到线程 revision ${expectedThreadRevision}`);
  };

  const updateThread = async (
    thread: CollaborationReviewThread,
    patch: {
      resolutionStatus?: CollaborationReviewResolutionStatus;
      reviewStatus?: CollaborationReviewLifecycleStatus;
      severity?: CollaborationReviewSeverity;
    },
    success = '审片状态已更新',
  ) => {
    const expectedCanvasRevision = canvasRevision;
    const expectedThreadRevision = thread.revision;
    await mutate(() => request(`/api/collab/reviews/${encodeURIComponent(thread.id)}`, {
      method: 'PATCH',
      body: JSON.stringify({
        ...patch,
        severity: patch.severity ?? thread.severity,
        expectedCanvasRevision,
        expectedThreadRevision,
      }),
    }), `${success} · 线程 revision ${expectedThreadRevision}`);
  };

  const markNotificationRead = async (notification: CollaborationReviewNotification) => {
    if (notification.readAt != null) return;
    try {
      const response = await request<CollaborationReviewNotification>(
        `/api/collab/notifications/${encodeURIComponent(notification.id)}/read`,
        { method: 'PATCH', body: JSON.stringify({}) },
      );
      setNotifications((current) => current.map((item) => item.id === notification.id
        ? response.data
        : item));
    } catch (error) {
      onStatus(error instanceof Error ? error.message : String(error));
    }
  };

  const openNotification = (notification: CollaborationReviewNotification) => {
    setSelectedThreadId(notification.threadId);
    setShowNotifications(false);
    void markNotificationRead(notification);
  };

  const loadComparison = async (thread: CollaborationReviewThread) => {
    setMutating(true);
    try {
      const response = await request<CollaborationReviewCompareResult>(
        `/api/collab/reviews/${encodeURIComponent(thread.id)}/compare`,
      );
      setComparison(response.data.comparison);
    } catch (error) {
      onStatus(error instanceof Error ? error.message : String(error));
    } finally { setMutating(false); }
  };

  const exportReviews = async (format: 'json' | 'markdown') => {
    try {
      const query = reviewQuery(canvasId, filters);
      query.set('format', format);
      const response = await request<unknown>(`/api/collab/reviews/export?${query}`);
      const text = typeof response.data === 'string'
        ? response.data
        : JSON.stringify(response.data, null, 2);
      const blob = new Blob([text], { type: format === 'json' ? 'application/json' : 'text/markdown' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `t8-review-${canvasId}.${format === 'json' ? 'json' : 'md'}`;
      link.click();
      URL.revokeObjectURL(url);
      onStatus(`审片汇总已导出为 ${format === 'json' ? 'JSON' : 'Markdown'}`);
    } catch (error) {
      onStatus(error instanceof Error ? error.message : String(error));
    }
  };

  const selectThreadAt = (index: number) => {
    const thread = threads[index];
    if (!thread) return;
    setSelectedThreadId(thread.id);
    if (thread.anchor.kind === 'node' && thread.anchor.targetEntityUid) {
      const node = nodes.find((candidate) => candidate.entityUid === thread.anchor.targetEntityUid);
      if (node) onSelectNode?.(node.id);
    }
  };

  const rootComments = useMemo(() => {
    if (!selectedThread) return [];
    const ids = new Set(selectedThread.comments.map((comment) => comment.id));
    return selectedThread.comments.filter((comment) => !comment.parentId || !ids.has(comment.parentId));
  }, [selectedThread]);
  const childrenByParent = useMemo(() => {
    const result = new Map<string, CollaborationReviewComment[]>();
    for (const comment of selectedThread?.comments || []) {
      if (!comment.parentId) continue;
      const children = result.get(comment.parentId) || [];
      children.push(comment);
      result.set(comment.parentId, children);
    }
    return result;
  }, [selectedThread]);

  const renderComment = (comment: CollaborationReviewComment, depth = 0, path = new Set<string>()): ReactElement => {
    const nextPath = new Set(path);
    nextPath.add(comment.id);
    const editing = textEditor?.entityUid === comment.entityUid;
    const authorOnly = canComment && online && safeMemberId(comment.createdBy) === safeMemberId(memberId);
    const author = comment.author?.displayName || memberById.get(safeMemberId(comment.createdBy))?.displayName || '协作者';
    const children = depth < 8
      ? (childrenByParent.get(comment.id) || []).filter((child) => !nextPath.has(child.id))
      : [];
    return (
      <article key={comment.id} className="mt-2 rounded border border-[var(--border-primary)] bg-[var(--bg-primary)] p-2" style={{ marginLeft: Math.min(depth, 4) * 10 }} data-comment-depth={depth}>
        <div className="flex items-center gap-2 text-[9px] text-[var(--text-secondary)]">
          <strong className="min-w-0 flex-1 truncate text-[var(--text-primary)]">{author}</strong>
          <span>{timestampLabel(comment.updatedAt || comment.createdAt)}</span>
        </div>
        {editing ? (
          <div className="mt-2">
            <textarea data-testid="collaboration-text-review-body" value={textEditor.text} rows={4} maxLength={5000} disabled={!online} className="w-full resize-y rounded border border-[var(--border-primary)] bg-[var(--bg-secondary)] p-2 text-xs disabled:opacity-50" onChange={(event) => onChangeCommentEditor?.(event.target.value)} />
            <div className="mt-2 flex gap-2">
              <button type="button" className="h-7 flex-1 rounded border border-[var(--border-primary)] text-[10px] font-bold disabled:opacity-40" disabled={!online || !textEditor.canUndo} onClick={onUndoCommentEditor}>撤销</button>
              <button type="button" className="h-7 flex-1 rounded border border-[var(--border-primary)] text-[10px] font-bold disabled:opacity-40" disabled={!online || !textEditor.canRedo} onClick={onRedoCommentEditor}>重做</button>
              <button type="button" className="h-7 rounded border border-[var(--border-primary)] px-2 text-[10px] font-bold" onClick={onCloseCommentEditor}>关闭</button>
            </div>
          </div>
        ) : <p className="mt-1 whitespace-pre-wrap break-words text-xs leading-5">{comment.body}</p>}
        {comment.mentions?.length > 0 && <div className="mt-2 flex flex-wrap gap-1">{comment.mentions.map((mention) => <span key={mention.memberId} className="rounded bg-[var(--accent-primary)]/10 px-1.5 py-0.5 text-[9px] text-[var(--accent-primary)]">@{mention.displayName}</span>)}</div>}
        {comment.attachments?.length > 0 && <div className="mt-2 flex flex-wrap gap-1">{comment.attachments.map((attachment, index) => attachment.available && attachment.asset ? <a key={`${attachment.assetUid}:${index}`} href={attachment.asset.representations?.preview || attachment.asset.sourceUrl || '#'} target="_blank" rel="noreferrer" className="max-w-full truncate rounded border border-[var(--border-primary)] px-1.5 py-0.5 text-[9px] text-[var(--accent-primary)]"><Paperclip size={9} className="mr-1 inline" />{attachment.asset.filename}</a> : <span key={`unavailable:${index}`} className="rounded border border-[var(--border-primary)] px-1.5 py-0.5 text-[9px] opacity-55">附件已不可用</span>)}</div>}
        {!editing && canComment && online && <div className="mt-2 flex gap-2">
          <button type="button" className="h-7 rounded border border-[var(--border-primary)] px-2 text-[9px] font-bold" onClick={() => setReplyDraft({ threadId: comment.threadId, parentId: comment.id, body: '', mentions: [], assetUids: [] })}><Reply size={10} className="mr-1 inline" />回复</button>
          {authorOnly && comment.entityUid && <button type="button" className="h-7 rounded border border-[var(--border-primary)] px-2 text-[9px] font-bold" onClick={() => void onOpenCommentEditor?.(comment)}>编辑自己的评论</button>}
        </div>}
        {children.map((child) => renderComment(child, depth + 1, nextPath))}
      </article>
    );
  };

  const canMutateSelected = Boolean(selectedThread && online && canComment);
  const lifecycleAuthority = { online, canComment, canApprove };
  const targetOptions = anchorKind === 'node'
    ? nodes.filter((node) => node.entityUid)
    : anchorKind === 'edge'
      ? edges.filter((edge) => edge.entityUid)
      : assets.filter((asset) => anchorKind !== 'video' || asset.kind === 'video');

  return (
    <section data-testid="collaboration-review-panel" className="mb-5 rounded border border-[var(--border-primary)] bg-[var(--bg-secondary)] p-3">
      <div className="flex items-center gap-2">
        <MessageSquare size={15} /><h3 className="text-xs font-bold">审片与评论</h3>
        <span className="text-[9px] opacity-55">{threads.length}/{total}</span>
        <button type="button" className="relative ml-auto grid h-7 w-7 place-items-center rounded border border-[var(--border-primary)]" title="通知" onClick={() => setShowNotifications((value) => !value)}><Bell size={12} />{unreadCount > 0 && <span className="absolute -right-1 -top-1 min-w-4 rounded-full bg-red-500 px-1 text-[8px] font-bold text-white">{unreadCount}</span>}</button>
        <button type="button" className="grid h-7 w-7 place-items-center rounded border border-[var(--border-primary)] disabled:opacity-40" disabled={loading} title="刷新评论" onClick={() => void loadReviews()}><RefreshCw size={12} /></button>
      </div>

      {showNotifications && <div data-testid="collaboration-review-notifications" className="mt-3 max-h-52 space-y-1 overflow-auto rounded border border-[var(--border-primary)] bg-[var(--bg-primary)] p-2">
        {notifications.map((notification) => (
          <button key={notification.id} type="button" className={`block w-full rounded border p-2 text-left text-[10px] ${notification.readAt == null ? 'border-[var(--accent-primary)] bg-[var(--accent-primary)]/10' : 'border-[var(--border-primary)]'}`} onClick={() => openNotification(notification)}>
            <strong>{notification.kind === 'review.mention' ? '有人提到了你' : notification.kind === 'review.reply' ? '评论有新回复' : '审片状态已更新'}</strong>
            <span className="ml-2 opacity-55">{memberById.get(safeMemberId(notification.actorId))?.displayName || '协作者'}</span>
            <div className="mt-1 opacity-55">{timestampLabel(notification.createdAt)}</div>
          </button>
        ))}
        {!notifications.length && <div className="py-4 text-center text-[10px] opacity-55">暂无通知</div>}
      </div>}

      <details className="mt-3 rounded border border-[var(--border-primary)] p-2" open>
        <summary className="cursor-pointer text-[10px] font-bold">筛选与导出</summary>
        <div className="mt-2 grid grid-cols-2 gap-2">
          <select aria-label="评审阶段筛选" value={filters.reviewStatus} className="h-8 rounded border border-[var(--border-primary)] bg-[var(--bg-primary)] px-1 text-[10px]" onChange={(event) => setFilters((current) => ({ ...current, reviewStatus: event.target.value as ReviewFilters['reviewStatus'] }))}><option value="">全部评审阶段</option><option value="draft">草稿</option><option value="in_review">审片中</option><option value="changes_requested">请求修改</option><option value="approved">已批准</option></select>
          <select aria-label="严重度筛选" value={filters.severity} className="h-8 rounded border border-[var(--border-primary)] bg-[var(--bg-primary)] px-1 text-[10px]" onChange={(event) => setFilters((current) => ({ ...current, severity: event.target.value as ReviewFilters['severity'] }))}><option value="">全部严重度</option>{Object.entries(SEVERITY_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
          <select aria-label="锚点筛选" value={filters.anchorKind} className="h-8 rounded border border-[var(--border-primary)] bg-[var(--bg-primary)] px-1 text-[10px]" onChange={(event) => setFilters((current) => ({ ...current, anchorKind: event.target.value as ReviewFilters['anchorKind'] }))}><option value="">全部锚点</option>{Object.entries(ANCHOR_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
          <select aria-label="成员筛选" value={filters.memberId} className="h-8 rounded border border-[var(--border-primary)] bg-[var(--bg-primary)] px-1 text-[10px]" onChange={(event) => setFilters((current) => ({ ...current, memberId: event.target.value }))}><option value="">全部成员</option>{members.map((member) => <option key={member.memberId} value={member.memberId}>{member.displayName}</option>)}</select>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-3 text-[9px]"><label><input type="checkbox" checked={filters.unresolved} onChange={(event) => setFilters((current) => ({ ...current, unresolved: event.target.checked }))} /> 仅未解决</label><label><input type="checkbox" checked={filters.approvalExpired} onChange={(event) => setFilters((current) => ({ ...current, approvalExpired: event.target.checked }))} /> 仅审批过期</label><button type="button" className="ml-auto underline" onClick={() => setFilters(EMPTY_FILTERS)}>清除</button></div>
        <div className="mt-2 flex gap-2"><button type="button" className="h-7 flex-1 rounded border border-[var(--border-primary)] text-[9px] font-bold" onClick={() => void exportReviews('json')}><Download size={10} className="mr-1 inline" />JSON</button><button type="button" className="h-7 flex-1 rounded border border-[var(--border-primary)] text-[9px] font-bold" onClick={() => void exportReviews('markdown')}><Download size={10} className="mr-1 inline" />Markdown</button></div>
      </details>

      {canComment && <details className="mt-3 rounded border border-[var(--border-primary)] p-2">
        <summary className="cursor-pointer text-[10px] font-bold">新建锚定评论</summary>
        <div className="mt-2 grid grid-cols-2 gap-2">
          <select aria-label="评论锚点类型" value={anchorKind} className="h-8 rounded border border-[var(--border-primary)] bg-[var(--bg-primary)] px-1 text-[10px]" onChange={(event) => { const next = event.target.value as AnchorKind; setAnchorKind(next); setAnchorTargetUid(next === 'node' ? selectedNode?.entityUid || '' : next === 'edge' ? selectedEdge?.entityUid || '' : ''); }}><option value="canvas">画布坐标</option><option value="node">节点</option><option value="edge">连线</option><option value="asset">素材</option><option value="video">视频帧</option></select>
          <select aria-label="评论严重度" value={severity} className="h-8 rounded border border-[var(--border-primary)] bg-[var(--bg-primary)] px-1 text-[10px]" onChange={(event) => setSeverity(event.target.value as CollaborationReviewSeverity)}>{Object.entries(SEVERITY_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
        </div>
        {anchorKind === 'canvas' ? <div className="mt-2 grid grid-cols-2 gap-2"><input aria-label="画布锚点 X" type="number" value={canvasX} className="h-8 rounded border border-[var(--border-primary)] bg-[var(--bg-primary)] px-2 text-[10px]" onChange={(event) => setCanvasX(event.target.value)} /><input aria-label="画布锚点 Y" type="number" value={canvasY} className="h-8 rounded border border-[var(--border-primary)] bg-[var(--bg-primary)] px-2 text-[10px]" onChange={(event) => setCanvasY(event.target.value)} /></div> : <select aria-label="锚点目标" value={anchorTargetUid} className="mt-2 h-8 w-full rounded border border-[var(--border-primary)] bg-[var(--bg-primary)] px-1 text-[10px]" onChange={(event) => setAnchorTargetUid(event.target.value)}><option value="">选择{ANCHOR_LABELS[anchorKind]}</option>{targetOptions.map((target) => <option key={target.entityUid} value={target.entityUid}>{'filename' in target ? String((target as CollaborationReviewAsset).filename) : String(target.data?.title || target.data?.label || target.id)}</option>)}</select>}
        {anchorKind === 'video' && <label className="mt-2 block text-[9px]">时间码 / 帧位置（毫秒）<input aria-label="视频帧毫秒" type="number" min="0" step="1" value={frameMs} className="mt-1 h-8 w-full rounded border border-[var(--border-primary)] bg-[var(--bg-primary)] px-2 text-[10px]" onChange={(event) => setFrameMs(event.target.value)} /></label>}
        <textarea value={body} rows={4} maxLength={5000} disabled={!online} className="mt-2 w-full resize-y rounded border border-[var(--border-primary)] bg-[var(--bg-primary)] p-2 text-xs disabled:opacity-50" placeholder="写下修改意见" onChange={(event) => setBody(event.target.value)} />
        <ReferencePicker members={members} assets={assets} value={references} disabled={!online || mutating} onChange={setReferences} />
        <button type="button" className="mt-2 flex h-8 w-full items-center justify-center gap-2 rounded bg-[var(--accent-primary)] text-[10px] font-bold text-white disabled:opacity-40" disabled={!online || mutating || !body.trim()} onClick={() => void submitThread()}><Send size={11} />按 canvas revision {canvasRevision} 保存审片草稿</button>
      </details>}

      <div className="mt-3 flex items-center gap-2">
        <button type="button" className="grid h-7 w-7 place-items-center rounded border border-[var(--border-primary)] disabled:opacity-30" disabled={selectedIndex <= 0} title="上一条" onClick={() => selectThreadAt(selectedIndex - 1)}><ChevronLeft size={12} /></button>
        <div className="min-w-0 flex-1 truncate text-center text-[9px]">{selectedIndex >= 0 ? `${selectedIndex + 1} / ${threads.length}` : '没有评论'}</div>
        <button type="button" className="grid h-7 w-7 place-items-center rounded border border-[var(--border-primary)] disabled:opacity-30" disabled={selectedIndex < 0 || selectedIndex >= threads.length - 1} title="下一条" onClick={() => selectThreadAt(selectedIndex + 1)}><ChevronRight size={12} /></button>
      </div>
      <div className="mt-2 max-h-44 space-y-1 overflow-auto">
        {threads.map((thread) => <button key={thread.id} type="button" className={`block w-full rounded border p-2 text-left ${thread.id === selectedThreadId ? 'border-[var(--accent-primary)] bg-[var(--accent-primary)]/10' : 'border-[var(--border-primary)]'}`} onClick={() => setSelectedThreadId(thread.id)}><div className="flex items-center gap-2 text-[10px] font-bold"><span>{REVIEW_STATUS_LABELS[thread.effectiveReviewStatus || thread.reviewStatus]}</span><span className="rounded border border-[var(--border-primary)] px-1 text-[8px]">{RESOLUTION_STATUS_LABELS[thread.resolutionStatus]}</span><span className="rounded border border-[var(--border-primary)] px-1 text-[8px]">{SEVERITY_LABELS[thread.severity]}</span><span className="ml-auto opacity-45">r{thread.revision}</span></div><div className="mt-1 truncate text-[9px] opacity-65">{anchorDisplay(thread, nodes, edges)}</div></button>)}
        {!threads.length && <div className="py-5 text-center text-[10px] opacity-55">当前筛选没有评论</div>}
      </div>

      {selectedThread && <article data-testid="collaboration-review-thread" className="mt-3 rounded border border-[var(--border-primary)] p-2">
        <div className="flex flex-wrap items-center gap-2 text-[10px]"><strong>{REVIEW_STATUS_LABELS[selectedThread.effectiveReviewStatus || selectedThread.reviewStatus]}</strong><span>{RESOLUTION_STATUS_LABELS[selectedThread.resolutionStatus]}</span><span>{SEVERITY_LABELS[selectedThread.severity]}</span><span className="ml-auto opacity-55">线程 r{selectedThread.revision} · 画布 r{selectedThread.canvasRevision}</span></div>
        <div className="mt-1 text-[9px] opacity-65">{anchorDisplay(selectedThread, nodes, edges)}</div>
        {selectedThread.anchor.kind === 'video' && selectedThread.anchor.contentChanged && <div role="alert" className="mt-2 rounded border border-amber-500/40 bg-amber-500/10 p-2 text-[9px] text-amber-600">视频内容已变化；此评论仍固定在原素材内容 revision/hash。</div>}
        {selectedThread.approvalExpired && <div role="alert" data-testid="collaboration-review-approval-expired" className="mt-2 rounded border border-amber-500/40 bg-amber-500/10 p-2 text-[9px] text-amber-600"><ShieldAlert size={11} className="mr-1 inline" />审批已过期：决定绑定 r{selectedThread.decisionCanvasRevision ?? '?'}，当前画布 r{selectedThread.currentCanvasRevision || canvasRevision}。</div>}
        <div className="mt-2 flex flex-wrap gap-1">
          <button type="button" className="h-7 rounded border border-[var(--border-primary)] px-2 text-[9px] font-bold disabled:opacity-40" disabled={mutating} onClick={() => void loadComparison(selectedThread)}><GitCompare size={10} className="mr-1 inline" />版本比较</button>
          {canMutateSelected && <select aria-label="线程严重度" value={selectedThread.severity} className="h-7 rounded border border-[var(--border-primary)] bg-[var(--bg-primary)] px-1 text-[9px]" onChange={(event) => void updateThread(selectedThread, { severity: event.target.value as CollaborationReviewSeverity }, '严重度已更新')}>{Object.entries(SEVERITY_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>}
          {canComment && online && <button type="button" className="h-7 rounded border border-[var(--border-primary)] px-2 text-[9px] font-bold" onClick={() => void updateThread(selectedThread, { resolutionStatus: oppositeCollaborationReviewResolutionStatus(selectedThread.resolutionStatus) }, selectedThread.resolutionStatus === 'open' ? '线程已解决' : '线程已重新打开')}>{selectedThread.resolutionStatus === 'open' ? '解决线程' : '重新打开线程'}</button>}
          {canPerformCollaborationReviewLifecycleAction(selectedThread.reviewStatus, 'submit_for_review', lifecycleAuthority) && <button type="button" className="h-7 rounded bg-[var(--accent-primary)] px-2 text-[9px] font-bold text-white" onClick={() => void updateThread(selectedThread, { reviewStatus: collaborationReviewLifecycleActionTarget(selectedThread.reviewStatus, 'submit_for_review') || undefined }, '已提交审片')}>提交审片</button>}
          {canPerformCollaborationReviewLifecycleAction(selectedThread.reviewStatus, 'resubmit_for_review', lifecycleAuthority) && <button type="button" className="h-7 rounded bg-[var(--accent-primary)] px-2 text-[9px] font-bold text-white" onClick={() => void updateThread(selectedThread, { reviewStatus: collaborationReviewLifecycleActionTarget(selectedThread.reviewStatus, 'resubmit_for_review') || undefined }, '已重新提交审片')}>重新提交审片</button>}
          {canPerformCollaborationReviewLifecycleAction(selectedThread.reviewStatus, 'approve', lifecycleAuthority) && <button type="button" className="h-7 rounded bg-green-600 px-2 text-[9px] font-bold text-white" onClick={() => void updateThread(selectedThread, { reviewStatus: 'approved' }, '审片已批准')}>批准</button>}
          {canPerformCollaborationReviewLifecycleAction(selectedThread.reviewStatus, 'request_changes', lifecycleAuthority) && <button type="button" className="h-7 rounded border border-amber-500/50 px-2 text-[9px] font-bold text-amber-600" onClick={() => void updateThread(selectedThread, { reviewStatus: 'changes_requested' }, '已请求修改')}>请求修改</button>}
          {canReassertCollaborationReviewDecision(selectedThread.reviewStatus, selectedThread.effectiveReviewStatus, lifecycleAuthority) && <button type="button" className="h-7 rounded border border-green-500/50 px-2 text-[9px] font-bold text-green-600" onClick={() => void updateThread(selectedThread, { reviewStatus: selectedThread.reviewStatus }, selectedThread.reviewStatus === 'approved' ? '已重新批准当前版本' : '已重新确认当前版本的修改请求')}>{selectedThread.reviewStatus === 'approved' ? '重新批准当前版本' : '重新确认修改请求'}</button>}
        </div>
        <div className="mt-2">{rootComments.map((comment) => renderComment(comment))}</div>
        {canComment && online && <button type="button" className="mt-2 h-7 w-full rounded border border-[var(--border-primary)] text-[9px] font-bold" onClick={() => setReplyDraft({ threadId: selectedThread.id, body: '', mentions: [], assetUids: [] })}><Reply size={10} className="mr-1 inline" />回复线程</button>}
        {replyDraft?.threadId === selectedThread.id && <div className="mt-2 rounded border border-[var(--accent-primary)]/40 p-2"><div className="flex items-center gap-2 text-[9px] font-bold"><span>{replyDraft.parentId ? '嵌套回复' : '回复线程'}</span><button type="button" className="ml-auto grid h-6 w-6 place-items-center" aria-label="关闭回复" onClick={() => setReplyDraft(null)}><X size={10} /></button></div><textarea value={replyDraft.body} rows={3} maxLength={5000} className="mt-2 w-full resize-y rounded border border-[var(--border-primary)] bg-[var(--bg-primary)] p-2 text-xs" onChange={(event) => setReplyDraft((current) => current ? { ...current, body: event.target.value } : current)} /><ReferencePicker members={members} assets={assets} value={replyDraft} disabled={mutating || !online} onChange={(next) => setReplyDraft((current) => current ? { ...current, ...next } : current)} /><button type="button" className="mt-2 h-7 w-full rounded bg-[var(--accent-primary)] text-[9px] font-bold text-white disabled:opacity-40" disabled={mutating || !replyDraft.body.trim()} onClick={() => void submitReply(selectedThread)}>按 canvas r{canvasRevision} / thread r{selectedThread.revision} 回复</button></div>}
      </article>}

      {comparison && <div data-testid="collaboration-review-comparison" className="mt-3 rounded border border-[var(--accent-primary)]/40 bg-[var(--bg-primary)] p-2"><div className="flex items-center gap-2 text-[10px] font-bold"><GitCompare size={11} />版本比较<button type="button" className="ml-auto grid h-6 w-6 place-items-center" aria-label="关闭版本比较" onClick={() => setComparison(null)}><X size={10} /></button></div><ul className="mt-2 max-h-44 space-y-1 overflow-auto text-[9px] leading-4">{safeComparisonLines(comparison).map((line, index) => <li key={`${index}:${line}`} className="break-words">{line}</li>)}</ul></div>}
    </section>
  );
}
