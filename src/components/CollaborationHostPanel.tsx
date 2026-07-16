import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Copy,
  Globe2,
  Link2,
  Loader2,
  Play,
  QrCode as QrCodeIcon,
  RefreshCw,
  ShieldCheck,
  Trash2,
  UserMinus,
  Users,
  Wifi,
} from 'lucide-react';
import QRCode from 'qrcode';
import * as api from '../services/api';
import type {
  CollaborationInvite,
  CollaborationMember,
  CollaborationSession,
  CollaborationStatus,
  RunIntent,
  WorkspaceRole,
} from '../types/project';

interface CollaborationHostPanelProps {
  projectId: string;
  canvasId?: string | null;
  onAcceptRunIntent: (intent: RunIntent) => Promise<boolean>;
}

type EditableWorkspaceRole = Exclude<WorkspaceRole, 'owner'>;

const EMPTY_STATUS: CollaborationStatus = {
  running: false,
  host: null,
  port: null,
  startedAt: null,
  connectionCount: 0,
  privateBackendExposed: false,
  networkInterfaces: [],
  shareUrls: [],
  defaultHost: '127.0.0.1',
  defaultPort: 18767,
  room: null,
};

const ROLE_LABELS: Record<WorkspaceRole, string> = {
  owner: '所有者',
  editor: '编辑者',
  reviewer: '审阅者',
  viewer: '查看者',
};

const EXPIRY_OPTIONS = [
  { label: '1 小时', value: 60 * 60 * 1000 },
  { label: '24 小时', value: 24 * 60 * 60 * 1000 },
  { label: '7 天', value: 7 * 24 * 60 * 60 * 1000 },
  { label: '30 天', value: 30 * 24 * 60 * 60 * 1000 },
];

function formatTime(value?: number | null) {
  return value ? new Date(value).toLocaleString() : '—';
}

function isLoopbackHost(hostname: string) {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return host === 'localhost' || host === '::1' || /^127\./.test(host);
}

function shareUrlRank(value: string) {
  try {
    const hostname = new URL(value).hostname;
    if (/^10\./.test(hostname) || /^192\.168\./.test(hostname) || /^172\.(1[6-9]|2\d|3[01])\./.test(hostname)) return 0;
    if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(hostname)) return 1;
    if (/^169\.254\./.test(hostname)) return 3;
    if (isLoopbackHost(hostname)) return 4;
    return 2;
  } catch {
    return 5;
  }
}

export function preferredCollaborationShareUrl(values: readonly string[]) {
  return [...new Set(values.filter(Boolean))]
    .sort((left, right) => shareUrlRank(left) - shareUrlRank(right) || left.localeCompare(right))[0] || '';
}

export function collaborationInviteUrl(baseUrl: string, code: string, canvasId?: string | null) {
  if (!baseUrl || !code) return '';
  try {
    const url = new URL(baseUrl);
    url.searchParams.set('invite', code);
    if (canvasId) url.searchParams.set('canvas', canvasId);
    else url.searchParams.delete('canvas');
    return url.toString();
  } catch {
    return '';
  }
}

function inviteState(invite: CollaborationInvite) {
  if (invite.revokedAt) return { label: '已撤销', className: 'text-red-500' };
  if (invite.expiresAt <= Date.now()) return { label: '已过期', className: 'text-amber-500' };
  if ((invite.useCount || 0) >= invite.maxUses) return { label: '已用完', className: 'text-amber-500' };
  return { label: '有效', className: 'text-green-500' };
}

export default function CollaborationHostPanel({
  projectId,
  canvasId,
  onAcceptRunIntent,
}: CollaborationHostPanelProps) {
  const [status, setStatus] = useState<CollaborationStatus>(EMPTY_STATUS);
  const [invites, setInvites] = useState<CollaborationInvite[]>([]);
  const [members, setMembers] = useState<CollaborationMember[]>([]);
  const [sessions, setSessions] = useState<CollaborationSession[]>([]);
  const [runIntents, setRunIntents] = useState<RunIntent[]>([]);
  const [selectedHost, setSelectedHost] = useState('');
  const [port, setPort] = useState(18767);
  const [shareBaseUrl, setShareBaseUrl] = useState('');
  const [inviteRole, setInviteRole] = useState<EditableWorkspaceRole>('reviewer');
  const [inviteExpiryMs, setInviteExpiryMs] = useState(7 * 24 * 60 * 60 * 1000);
  const [inviteMaxUses, setInviteMaxUses] = useState(20);
  const [latestInvite, setLatestInvite] = useState<CollaborationInvite | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [mutation, setMutation] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [stopConfirm, setStopConfirm] = useState(false);
  const [resourceScopeConfirm, setResourceScopeConfirm] = useState(false);
  const [revokeAllConfirm, setRevokeAllConfirm] = useState(false);
  const [removeMemberConfirmId, setRemoveMemberConfirmId] = useState<string | null>(null);
  const [revokeSessionConfirmId, setRevokeSessionConfirmId] = useState<string | null>(null);
  const loadGenerationRef = useRef(0);
  const loadAbortRef = useRef<AbortController | null>(null);
  const scopeKey = `${projectId}:${canvasId || ''}`;

  const refresh = useCallback(async (quiet = false) => {
    const generation = ++loadGenerationRef.current;
    loadAbortRef.current?.abort();
    const controller = new AbortController();
    loadAbortRef.current = controller;
    if (!quiet) setLoading(true);
    setError('');
    try {
      const [nextStatus, nextInvites, nextMembers, nextSessions, nextRunIntents] = await Promise.all([
        api.getCollaborationStatus(projectId, canvasId, { signal: controller.signal }),
        canvasId ? api.listCollaborationInvites(projectId, canvasId, { signal: controller.signal }) : Promise.resolve([]),
        canvasId ? api.listCollaborationMembers(projectId, canvasId, { signal: controller.signal }) : Promise.resolve([]),
        canvasId ? api.listCollaborationSessions(projectId, canvasId, { signal: controller.signal }) : Promise.resolve([]),
        canvasId ? api.listCollaborationRunIntents('actionable', projectId, canvasId, { signal: controller.signal }) : Promise.resolve([]),
      ]);
      if (controller.signal.aborted || generation !== loadGenerationRef.current) return;
      setStatus(nextStatus);
      setInvites(nextInvites);
      setMembers(nextMembers);
      setSessions(nextSessions);
      setRunIntents(nextRunIntents.filter((intent) => !canvasId || intent.canvasId === canvasId));
      setSelectedHost((current) => {
        if (current && nextStatus.networkInterfaces.some((entry) => entry.address === current)) return current;
        return nextStatus.host || nextStatus.defaultHost || '127.0.0.1';
      });
      setPort(nextStatus.port || nextStatus.defaultPort || 18767);
      setShareBaseUrl((current) => (
        current && nextStatus.shareUrls.includes(current)
          ? current
          : nextStatus.shareUrls.length === 1
            ? nextStatus.shareUrls[0]
            : ''
      ));
    } catch (refreshError) {
      if (controller.signal.aborted) return;
      setError(refreshError instanceof Error ? refreshError.message : String(refreshError));
    } finally {
      if (generation === loadGenerationRef.current) setLoading(false);
    }
  }, [canvasId, projectId]);

  useEffect(() => {
    setStatus(EMPTY_STATUS);
    setInvites([]);
    setMembers([]);
    setSessions([]);
    setRunIntents([]);
    setSelectedHost('');
    setShareBaseUrl('');
    setLatestInvite(null);
    setNotice('');
    setError('');
    setStopConfirm(false);
    setResourceScopeConfirm(false);
    setRevokeAllConfirm(false);
    setRemoveMemberConfirmId(null);
    setRevokeSessionConfirmId(null);
    void refresh();
    return () => loadAbortRef.current?.abort();
  }, [refresh, scopeKey]);

  const latestInviteUrl = useMemo(() => {
    if (!latestInvite) return '';
    if (latestInvite.code && shareBaseUrl) {
      const scoped = collaborationInviteUrl(shareBaseUrl, latestInvite.code, canvasId);
      if (scoped) return scoped;
    }
    return preferredCollaborationShareUrl([
      ...(latestInvite.shareUrls || []),
      latestInvite.localUrl || '',
    ]);
  }, [canvasId, latestInvite, shareBaseUrl]);

  useEffect(() => {
    let cancelled = false;
    if (!latestInviteUrl) {
      setQrDataUrl('');
      return undefined;
    }
    void QRCode.toDataURL(latestInviteUrl, {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 220,
      color: { dark: '#111827', light: '#ffffff' },
    }).then((value) => {
      if (!cancelled) setQrDataUrl(value);
    }).catch(() => {
      if (!cancelled) setQrDataUrl('');
    });
    return () => {
      cancelled = true;
    };
  }, [latestInviteUrl]);

  const runMutation = useCallback(async <T,>(
    key: string,
    action: () => Promise<T>,
    success: string | ((result: T) => string),
  ): Promise<T | null> => {
    if (mutation) return null;
    setMutation(key);
    setError('');
    setNotice('');
    try {
      const result = await action();
      setNotice(typeof success === 'function' ? success(result) : success);
      await refresh(true);
      return result;
    } catch (mutationError) {
      setError(mutationError instanceof Error ? mutationError.message : String(mutationError));
      return null;
    } finally {
      setMutation(null);
    }
  }, [mutation, refresh]);

  const copyText = useCallback(async (value: string, successMessage: string) => {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setNotice(successMessage);
      setError('');
    } catch {
      setError('复制失败，请选中地址后手动复制。');
    }
  }, []);

  const selectedInterface = status.networkInterfaces.find((entry) => entry.address === selectedHost);
  const exposesNetwork = selectedInterface
    ? selectedInterface.scope !== 'loopback'
    : !isLoopbackHost(selectedHost);
  const roomConnectionCount = status.room?.connectionCount ?? status.connectionCount;
  const activeSessions = sessions.filter((session) => session.active).length;
  const liveSessions = sessions.filter((session) => session.connected).length;
  const resourceScope = status.room?.resourceScope || null;
  const resourceScopeReady = resourceScope?.ready ?? true;

  const startGateway = () => {
    if (!selectedHost) {
      setError('请选择监听网卡。');
      return;
    }
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      setError('协作端口必须是 1024-65535 的整数。');
      return;
    }
    setStopConfirm(false);
    void runMutation(
      'gateway-start',
      () => api.startCollaborationGateway({ host: selectedHost, port }),
      (next) => next.running ? `协作网关已监听 ${next.host}:${next.port}。` : '协作网关未能进入运行状态。',
    );
  };

  const stopGateway = () => {
    if (!stopConfirm) {
      setStopConfirm(true);
      setNotice('停止网关会断开所有项目的协作连接；请再次点击确认。');
      return;
    }
    setStopConfirm(false);
    void runMutation('gateway-stop', api.stopCollaborationGateway, '协作网关已停止，监听端口已经关闭。');
  };

  const createInvite = () => {
    if (!canvasId) {
      setError('当前项目尚未选中画布，不能创建画布邀请。');
      return;
    }
    if (!status.running || !shareBaseUrl) {
      setError('请先启动网关并选择一个实际共享地址。');
      return;
    }
    if (!resourceScopeReady) {
      setError('请先由主机确认当前画布的协作资源范围。');
      return;
    }
    void runMutation(
      'invite-create',
      async () => {
        const invite = await api.createCollaborationInvite({
          projectId,
          canvasId,
          role: inviteRole,
          expiresInMs: inviteExpiryMs,
          maxUses: inviteMaxUses,
        });
        setLatestInvite(invite);
        const url = invite.code
          ? collaborationInviteUrl(shareBaseUrl, invite.code, canvasId)
          : preferredCollaborationShareUrl([...(invite.shareUrls || []), invite.localUrl || '']);
        if (!url) throw new Error('邀请已创建，但网关没有返回可共享地址。');
        try {
          await navigator.clipboard.writeText(url);
        } catch {
          // The visible input remains the manual-copy fallback.
        }
        return { invite, url };
      },
      ({ url }) => `邀请已创建并生成本机二维码：${url}`,
    );
  };

  const initializeResourceScope = () => {
    if (!canvasId) {
      setError('当前项目尚未选中画布。');
      return;
    }
    if (!resourceScopeConfirm) {
      setResourceScopeConfirm(true);
      setNotice('再次点击将把当前画布引用的素材和固定子工作流版本设为本房间可访问资源。');
      return;
    }
    setResourceScopeConfirm(false);
    void runMutation(
      'resource-scope-initialize',
      () => api.initializeCollaborationResourceScope(projectId, canvasId),
      (next) => `协作资源范围已确认：${next.assetCount} 个素材、${next.subflowCount} 个固定子工作流版本。`,
    );
  };

  const updateMemberRole = (member: CollaborationMember, role: EditableWorkspaceRole) => {
    if (member.role === role) return;
    setRemoveMemberConfirmId(null);
    void runMutation(
      `member-role:${member.id}`,
      () => api.updateCollaborationMember(member.id, projectId, canvasId || '', { role }),
      (updated) => `“${updated.displayName}”已改为${ROLE_LABELS[updated.role]}，刷新 ${updated.disconnectedConnections || 0} 条在线连接；原会话仍可继续使用。`,
    );
  };

  const removeMember = (member: CollaborationMember) => {
    if (removeMemberConfirmId !== member.id) {
      setRemoveMemberConfirmId(member.id);
      setNotice(`再次点击可移除“${member.displayName}”并撤销其全部会话。`);
      return;
    }
    setRemoveMemberConfirmId(null);
    void runMutation(
      `member-remove:${member.id}`,
      () => api.removeCollaborationMember(member.id, projectId, canvasId || ''),
      (removed) => `已移除“${removed.displayName}”，断开 ${removed.disconnectedConnections || 0} 条连接。`,
    );
  };

  const revokeSession = (session: CollaborationSession) => {
    if (revokeSessionConfirmId !== session.id) {
      setRevokeSessionConfirmId(session.id);
      setNotice(`再次点击可撤销“${session.displayName}”的当前会话。`);
      return;
    }
    setRevokeSessionConfirmId(null);
    void runMutation(
      `session-revoke:${session.id}`,
      () => api.revokeCollaborationSession(session.id, projectId, canvasId || ''),
      (revoked) => `会话已撤销，断开 ${revoked.disconnectedConnections || 0} 条连接。`,
    );
  };

  const revokeAllSessions = () => {
    if (!revokeAllConfirm) {
      setRevokeAllConfirm(true);
      setNotice('再次点击将撤销当前画布房间的全部会话并立即断开在线连接。');
      return;
    }
    setRevokeAllConfirm(false);
    void runMutation(
      'sessions-revoke-all',
      () => api.revokeAllCollaborationSessions(projectId, canvasId || ''),
      (result) => `已撤销 ${result.revokedSessions} 个会话并断开 ${result.disconnectedConnections} 条连接。`,
    );
  };

  const acceptRunIntent = (intent: RunIntent) => {
    void runMutation(
      `intent-accept:${intent.id}`,
      () => onAcceptRunIntent(intent),
      (accepted) => accepted ? '运行请求已由主机接受。' : '运行请求未执行，请检查主机运行状态。',
    );
  };

  const rejectRunIntent = (intent: RunIntent) => {
    void runMutation(
      `intent-reject:${intent.id}`,
      () => api.updateCollaborationRunIntent(intent.id, projectId, canvasId || '', { status: 'rejected' }),
      '运行请求已拒绝。',
    );
  };

  return (
    <section className="mx-auto max-w-4xl space-y-5" data-testid="collaboration-host-panel" data-project-id={projectId} data-canvas-id={canvasId || ''}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-2 text-sm font-bold"><Globe2 size={17} />独立协作网关</h3>
          <p className="mt-1 text-xs leading-5 text-[var(--text-secondary)]">当前房间：{projectId} / {canvasId || '未选择画布'}。管理接口仅允许本机访问，私有后端不会被代理。</p>
        </div>
        <div className="flex items-center gap-2">
          <span className={`rounded px-3 py-1 text-xs font-bold ${status.running ? 'bg-green-500/15 text-green-500' : 'bg-zinc-500/15 text-[var(--text-secondary)]'}`}>
            {status.running ? '已运行' : '未启动'}
          </span>
          <button type="button" className="grid h-8 w-8 place-items-center rounded border border-[var(--border-primary)] disabled:opacity-40" disabled={loading || Boolean(mutation)} title="刷新协作状态" onClick={() => void refresh()}>
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {(notice || error) && (
        <div role={error ? 'alert' : 'status'} className={`rounded border p-3 text-xs leading-5 ${error ? 'border-red-500/40 bg-red-500/10 text-red-500' : 'border-green-500/35 bg-green-500/10 text-green-600'}`}>
          {error || notice}
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-4">
        <div className="rounded border border-[var(--border-primary)] bg-[var(--bg-secondary)] p-3"><div className="text-[10px] text-[var(--text-secondary)]">当前房间在线连接</div><div className="mt-1 text-xl font-black">{roomConnectionCount}</div></div>
        <div className="rounded border border-[var(--border-primary)] bg-[var(--bg-secondary)] p-3"><div className="text-[10px] text-[var(--text-secondary)]">房间成员</div><div className="mt-1 text-xl font-black">{status.room?.memberCount ?? members.length}</div></div>
        <div className="rounded border border-[var(--border-primary)] bg-[var(--bg-secondary)] p-3"><div className="text-[10px] text-[var(--text-secondary)]">有效 / 在线会话</div><div className="mt-1 text-xl font-black">{activeSessions} / {liveSessions}</div></div>
        <div className="rounded border border-[var(--border-primary)] bg-[var(--bg-secondary)] p-3"><div className="text-[10px] text-[var(--text-secondary)]">网关启动时间</div><div className="mt-2 text-xs font-bold">{formatTime(status.startedAt)}</div></div>
      </div>

      <div className="rounded border border-[var(--border-primary)] p-4" data-testid="collaboration-gateway-settings">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div><h4 className="text-xs font-bold">监听设置</h4><p className="mt-1 text-[10px] text-[var(--text-secondary)]">明确选择本机 IPv4 网卡；切换地址或端口会安全重启网关。</p></div>
          <span className="flex items-center gap-1 text-[10px] text-green-600"><ShieldCheck size={13} />私有后端暴露：{status.privateBackendExposed ? '是' : '否'}</span>
        </div>
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_150px]">
          <label className="text-xs font-semibold">监听网卡
            <select value={selectedHost} className="mt-1 h-10 w-full rounded border border-[var(--border-primary)] bg-[var(--bg-secondary)] px-3" onChange={(event) => setSelectedHost(event.target.value)}>
              {!status.networkInterfaces.length && <option value={selectedHost || '127.0.0.1'}>{selectedHost || '127.0.0.1'}</option>}
              {selectedHost && !status.networkInterfaces.some((entry) => entry.address === selectedHost) && <option value={selectedHost}>{selectedHost} · 当前监听</option>}
              {status.networkInterfaces.map((entry) => <option key={entry.id} value={entry.address}>{entry.label}</option>)}
            </select>
          </label>
          <label className="text-xs font-semibold">端口
            <input type="number" min={1024} max={65535} value={port} className="mt-1 h-10 w-full rounded border border-[var(--border-primary)] bg-[var(--bg-secondary)] px-3" onChange={(event) => setPort(Number(event.target.value) || 0)} />
          </label>
        </div>
        {exposesNetwork && (
          <div className="mt-3 rounded border border-amber-500/40 bg-amber-500/10 p-3 text-xs leading-5 text-amber-600">
            {selectedHost === '0.0.0.0' ? '将监听全部 IPv4 网卡。请只在可信网络中使用，并逐一核对下方实际共享地址。' : '该地址允许同一网络的其他设备连接；请确认 Windows 防火墙和网络可信。'}
          </div>
        )}
        <div className="mt-4 flex flex-wrap gap-2">
          <button type="button" className="flex h-10 flex-1 items-center justify-center gap-2 rounded bg-[var(--accent-primary)] px-4 text-xs font-bold text-white disabled:opacity-40" disabled={Boolean(mutation)} onClick={startGateway}>
            {mutation === 'gateway-start' ? <Loader2 size={15} className="animate-spin" /> : <Wifi size={15} />}{status.running ? '应用监听设置' : '启动网关'}
          </button>
          <button type="button" className={`h-10 rounded border px-4 text-xs font-bold disabled:opacity-40 ${stopConfirm ? 'border-red-500 bg-red-500/10 text-red-500' : 'border-[var(--border-primary)]'}`} disabled={!status.running || Boolean(mutation)} onClick={stopGateway}>
            {mutation === 'gateway-stop' ? '停止中…' : stopConfirm ? '再次确认停止' : '停止网关'}
          </button>
          {stopConfirm && <button type="button" className="h-10 rounded border border-[var(--border-primary)] px-3 text-xs" onClick={() => setStopConfirm(false)}>取消</button>}
        </div>
      </div>

      <div className="rounded border border-[var(--border-primary)] p-4" data-testid="collaboration-share-address">
        <div className="mb-3"><h4 className="flex items-center gap-2 text-xs font-bold"><Link2 size={14} />实际共享地址</h4><p className="mt-1 text-[10px] text-[var(--text-secondary)]">地址由当前监听网卡和真实端口生成，不会使用不可达的 127.0.0.1 替代局域网地址。</p></div>
        {status.running && status.shareUrls.length ? (
          <div className="flex gap-2">
            <select value={shareBaseUrl} className="h-10 min-w-0 flex-1 rounded border border-[var(--border-primary)] bg-[var(--bg-secondary)] px-3 text-xs" onChange={(event) => setShareBaseUrl(event.target.value)}>
              {status.shareUrls.length > 1 && <option value="" disabled>请选择实际共享地址</option>}
              {status.shareUrls.map((url) => <option key={url} value={url}>{url}</option>)}
            </select>
            <button type="button" className="grid h-10 w-10 shrink-0 place-items-center rounded border border-[var(--border-primary)]" title="复制共享地址" onClick={() => void copyText(shareBaseUrl, '共享地址已复制。')}><Copy size={14} /></button>
          </div>
        ) : <div className="rounded bg-[var(--bg-secondary)] p-3 text-xs text-[var(--text-secondary)]">启动网关后显示可从其他设备访问的地址。</div>}
      </div>

      <div className="rounded border border-[var(--border-primary)] p-4" data-testid="collaboration-invite-management">
        <div className="mb-3"><h4 className="text-xs font-bold">创建邀请</h4><p className="mt-1 text-[10px] text-[var(--text-secondary)]">邀请强制绑定当前项目与画布；二维码在本机生成，不上传到第三方服务。</p></div>
        {!resourceScopeReady && (
          <div className="mb-3 rounded border border-amber-500/40 bg-amber-500/10 p-3 text-xs leading-5 text-amber-700" data-testid="collaboration-resource-scope-confirmation">
            <div className="flex items-start gap-2">
              <AlertTriangle size={16} className="mt-0.5 shrink-0" />
              <div>
                <div className="font-bold">首次共享前需要确认资源范围</div>
                <p className="mt-1">系统尚未信任旧画布中的资源引用。确认后只授权当前画布引用的素材与固定子工作流版本；后续协作者不能靠写入资源 ID 扩权。</p>
              </div>
            </div>
            <button
              type="button"
              className={`mt-3 h-9 w-full rounded border px-3 text-xs font-bold disabled:opacity-40 ${resourceScopeConfirm ? 'border-amber-600 bg-amber-500/15' : 'border-amber-500/50'}`}
              disabled={!canvasId || Boolean(mutation)}
              onClick={initializeResourceScope}
            >
              {mutation === 'resource-scope-initialize'
                ? '初始化中…'
                : resourceScopeConfirm ? '再次确认当前资源范围' : '检查说明并初始化资源范围'}
            </button>
          </div>
        )}
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="text-xs font-semibold">角色
            <select value={inviteRole} className="mt-1 h-10 w-full rounded border border-[var(--border-primary)] bg-[var(--bg-secondary)] px-3" onChange={(event) => setInviteRole(event.target.value as EditableWorkspaceRole)}>
              <option value="editor">编辑者</option><option value="reviewer">审阅者</option><option value="viewer">查看者</option>
            </select>
          </label>
          <label className="text-xs font-semibold">有效期
            <select value={inviteExpiryMs} className="mt-1 h-10 w-full rounded border border-[var(--border-primary)] bg-[var(--bg-secondary)] px-3" onChange={(event) => setInviteExpiryMs(Number(event.target.value))}>
              {EXPIRY_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
          <label className="text-xs font-semibold">最大使用次数
            <input type="number" min={1} max={100} value={inviteMaxUses} className="mt-1 h-10 w-full rounded border border-[var(--border-primary)] bg-[var(--bg-secondary)] px-3" onChange={(event) => setInviteMaxUses(Math.max(1, Math.min(100, Number(event.target.value) || 1)))} />
          </label>
        </div>
        <button type="button" className="mt-3 flex h-10 w-full items-center justify-center gap-2 rounded bg-[var(--accent-primary)] text-xs font-bold text-white disabled:opacity-40" disabled={!status.running || !canvasId || !shareBaseUrl || !resourceScopeReady || Boolean(mutation)} onClick={createInvite}>
          {mutation === 'invite-create' ? <Loader2 size={15} className="animate-spin" /> : <QrCodeIcon size={15} />}生成邀请、复制链接与二维码
        </button>
        {latestInviteUrl && (
          <div className="mt-4 grid gap-4 rounded border border-[var(--border-primary)] bg-[var(--bg-secondary)] p-3 sm:grid-cols-[minmax(0,1fr)_180px]">
            <div className="min-w-0"><div className="text-[10px] font-bold text-green-600">最新邀请</div><div className="mt-2 flex gap-2"><input readOnly value={latestInviteUrl} className="h-10 min-w-0 flex-1 rounded border border-[var(--border-primary)] bg-[var(--bg-primary)] px-3 text-xs" onFocus={(event) => event.currentTarget.select()} /><button type="button" className="grid h-10 w-10 shrink-0 place-items-center rounded border border-[var(--border-primary)]" onClick={() => void copyText(latestInviteUrl, '邀请链接已复制。')}><Copy size={14} /></button></div><p className="mt-2 text-[10px] text-[var(--text-secondary)]">{ROLE_LABELS[latestInvite?.role || inviteRole]} · 到期 {formatTime(latestInvite?.expiresAt)}</p></div>
            <div className="grid place-items-center">{qrDataUrl ? <img src={qrDataUrl} alt="协作邀请二维码" className="h-40 w-40 rounded bg-white p-1" /> : <Loader2 size={20} className="animate-spin" />}</div>
          </div>
        )}
        <div className="mt-4 space-y-2">
          <div className="flex items-center justify-between"><h5 className="text-[11px] font-bold">邀请记录</h5><span className="text-[10px] text-[var(--text-secondary)]">{invites.length}</span></div>
          {invites.map((invite) => {
            const state = inviteState(invite);
            return <article key={invite.id} className="flex items-center gap-3 rounded border border-[var(--border-primary)] bg-[var(--bg-secondary)] p-3 text-xs"><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><strong>{ROLE_LABELS[invite.role]}</strong><span className={state.className}>{state.label}</span></div><div className="mt-1 text-[10px] text-[var(--text-secondary)]">使用 {invite.useCount || 0}/{invite.maxUses} · 到期 {formatTime(invite.expiresAt)} · {invite.id}</div></div><button type="button" className="grid h-8 w-8 place-items-center rounded border border-[var(--border-primary)] text-red-500 disabled:opacity-30" title="撤销邀请" disabled={Boolean(invite.revokedAt) || Boolean(mutation)} onClick={() => void runMutation(`invite-revoke:${invite.id}`, () => api.revokeCollaborationInvite(invite.id, projectId, canvasId || ''), '邀请已撤销。')}><Trash2 size={13} /></button></article>;
          })}
          {!invites.length && !loading && <div className="py-4 text-center text-xs text-[var(--text-secondary)]">暂无邀请记录</div>}
        </div>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <div className="rounded border border-[var(--border-primary)] p-4" data-testid="collaboration-member-management">
          <div className="mb-3 flex items-center justify-between"><div><h4 className="flex items-center gap-2 text-xs font-bold"><Users size={14} />成员</h4><p className="mt-1 text-[10px] text-[var(--text-secondary)]">修改角色会刷新在线连接，原会话和成员身份保持不变。</p></div><span className="text-[10px] text-[var(--text-secondary)]">{members.length}</span></div>
          <div className="max-h-80 space-y-2 overflow-auto">
            {members.map((member) => <article key={member.id} className="rounded border border-[var(--border-primary)] bg-[var(--bg-secondary)] p-3 text-xs"><div className="flex items-start gap-2"><span className={`mt-1 h-2 w-2 rounded-full ${member.online ? 'bg-green-500' : 'bg-zinc-400'}`} /><div className="min-w-0 flex-1"><div className="truncate font-bold">{member.displayName}</div><div className="mt-1 text-[10px] text-[var(--text-secondary)]">{member.connectionCount || 0} 连接 · {member.sessionCount || 0} 会话 · 最后活动 {formatTime(member.lastSeenAt)}</div></div></div><div className="mt-3 flex gap-2"><select value={member.role} className="h-8 min-w-0 flex-1 rounded border border-[var(--border-primary)] bg-[var(--bg-primary)] px-2 text-[11px] disabled:opacity-60" disabled={member.role === 'owner' || Boolean(mutation)} onChange={(event) => updateMemberRole(member, event.target.value as EditableWorkspaceRole)}><option value="owner" disabled>所有者</option><option value="editor">编辑者</option><option value="reviewer">审阅者</option><option value="viewer">查看者</option></select><button type="button" className={`flex h-8 items-center gap-1 rounded border px-2 text-[10px] disabled:opacity-30 ${removeMemberConfirmId === member.id ? 'border-red-500 bg-red-500/10 text-red-500' : 'border-[var(--border-primary)]'}`} disabled={member.role === 'owner' || Boolean(mutation)} onClick={() => removeMember(member)}><UserMinus size={12} />{removeMemberConfirmId === member.id ? '再次确认' : '移除'}</button></div></article>)}
            {!members.length && !loading && <div className="py-4 text-center text-xs text-[var(--text-secondary)]">暂无成员</div>}
          </div>
        </div>

        <div className="rounded border border-[var(--border-primary)] p-4" data-testid="collaboration-session-management">
          <div className="mb-3 flex items-start justify-between gap-3"><div><h4 className="flex items-center gap-2 text-xs font-bold"><Wifi size={14} />会话</h4><p className="mt-1 text-[10px] text-[var(--text-secondary)]">撤销后立即关闭匹配的 WebSocket 连接。</p></div><button type="button" className={`shrink-0 rounded border px-2 py-1 text-[10px] font-bold disabled:opacity-30 ${revokeAllConfirm ? 'border-red-500 bg-red-500/10 text-red-500' : 'border-[var(--border-primary)]'}`} disabled={!activeSessions || Boolean(mutation)} onClick={revokeAllSessions}>{revokeAllConfirm ? '再次确认全部断开' : '断开全部会话'}</button></div>
          <div className="max-h-80 space-y-2 overflow-auto">
            {sessions.map((session) => <article key={session.id} className="flex items-center gap-2 rounded border border-[var(--border-primary)] bg-[var(--bg-secondary)] p-3 text-xs"><span className={`h-2 w-2 shrink-0 rounded-full ${session.connected ? 'bg-green-500' : session.active ? 'bg-amber-500' : 'bg-zinc-400'}`} /><div className="min-w-0 flex-1"><div className="truncate font-bold">{session.displayName} · {ROLE_LABELS[session.role]}</div><div className="mt-1 text-[10px] text-[var(--text-secondary)]">{session.connected ? `${session.connectionCount || 0} 条在线连接` : session.active ? '有效但离线' : session.revokedAt ? '已撤销' : '已过期'} · 最后活动 {formatTime(session.lastSeenAt)}</div></div><button type="button" className={`shrink-0 rounded border px-2 py-1 text-[10px] disabled:opacity-30 ${revokeSessionConfirmId === session.id ? 'border-red-500 text-red-500' : 'border-[var(--border-primary)]'}`} disabled={!session.active || Boolean(mutation)} onClick={() => revokeSession(session)}>{revokeSessionConfirmId === session.id ? '再次确认' : '撤销'}</button></article>)}
            {!sessions.length && !loading && <div className="py-4 text-center text-xs text-[var(--text-secondary)]">暂无会话</div>}
          </div>
        </div>
      </div>

      <div className="rounded border border-[var(--border-primary)] p-4" data-testid="collaboration-run-intents">
        <div className="mb-3 flex items-center justify-between"><div><h4 className="flex items-center gap-2 text-xs font-bold"><Play size={14} />待处理运行请求</h4><p className="mt-1 text-[10px] text-[var(--text-secondary)]">远端只能提交意图；Provider 调用仍由本机主机确认并执行。</p></div><span className="text-[10px] text-[var(--text-secondary)]">{runIntents.length}</span></div>
        <div className="space-y-2">
          {runIntents.map((intent) => <article key={intent.id} className="flex flex-wrap items-center gap-3 rounded border border-[var(--border-primary)] bg-[var(--bg-secondary)] p-3"><div className="min-w-0 flex-1"><div className="truncate text-xs font-bold">{intent.requestedBy}</div><div className="mt-1 text-[10px] text-[var(--text-secondary)]">revision {intent.canvasRevision} · {intent.nodeIds.length || '全部'} 节点 · {formatTime(intent.createdAt)}</div></div><button type="button" className="h-8 rounded bg-[var(--accent-primary)] px-3 text-[11px] font-bold text-white disabled:opacity-40" disabled={Boolean(mutation)} onClick={() => acceptRunIntent(intent)}>接受</button><button type="button" className="h-8 rounded border border-[var(--border-primary)] px-3 text-[11px] font-bold disabled:opacity-40" disabled={Boolean(mutation)} onClick={() => rejectRunIntent(intent)}>拒绝</button></article>)}
          {!runIntents.length && !loading && <div className="py-5 text-center text-xs text-[var(--text-secondary)]">暂无远程运行请求</div>}
        </div>
      </div>
    </section>
  );
}
