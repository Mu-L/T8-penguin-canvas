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
  ScrollText,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  UserMinus,
  Users,
  Wifi,
} from 'lucide-react';
import QRCode from 'qrcode';
import * as api from '../services/api';
import {
  collaborationHostScopeKey,
  createCollaborationHostScopeFence,
  runCollaborationHostScopedMutation,
  type CollaborationHostScopeToken,
} from '../utils/collaborationHostScopeFence';
import type {
  CollaborationAuditPage,
  CollaborationExecutionPolicySnapshot,
  CollaborationInvite,
  CollaborationMember,
  CollaborationPublicSelfCheck,
  CollaborationRoomExecutionPolicySnapshot,
  CollaborationReviewVisibilityPolicy,
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

const PUBLIC_SELF_CHECK_LABELS = {
  health: 'Health',
  invite: '邀请兑换',
  websocket: 'WebSocket Upgrade',
  upload: '微型 Upload',
  range: 'Range',
} as const;

const EMPTY_AUDIT_PAGE: CollaborationAuditPage = {
  events: [],
  pagination: {
    offset: 0,
    limit: 25,
    nextOffset: null,
    hasMoreWithinWindow: false,
    totalWithinWindow: 0,
    windowLimit: 1000,
    sourceTruncated: false,
  },
};

const EMPTY_AUDIT_FILTERS: Readonly<{ action: string; actorId: string; targetType: string }> = Object.freeze({
  action: '',
  actorId: '',
  targetType: '',
});

function formatTime(value?: number | null) {
  return value ? new Date(value).toLocaleString() : '—';
}

function formatPolicyLimit(value?: number | null, suffix = '') {
  return Number(value) > 0 ? `${Number(value)}${suffix}` : '不限';
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

export function collaborationPublicUrlRisk(value: string) {
  try {
    const parsed = new URL(value.trim());
    const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    const local = isLoopbackHost(hostname)
      || /^10\./.test(hostname)
      || /^192\.168\./.test(hostname)
      || /^172\.(1[6-9]|2\d|3[01])\./.test(hostname)
      || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(hostname)
      || /^169\.254\./.test(hostname);
    return {
      valid: ['http:', 'https:'].includes(parsed.protocol)
        && !parsed.username
        && !parsed.password
        && !parsed.search
        && !parsed.hash
        && parsed.hostname !== '0.0.0.0'
        && parsed.pathname.replace(/\/+$/, '').endsWith('/collab'),
      insecurePublic: !local && parsed.protocol === 'http:',
    };
  } catch {
    return { valid: false, insecurePublic: false };
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
  const [executionPolicy, setExecutionPolicy] = useState<CollaborationExecutionPolicySnapshot | null>(null);
  const [roomExecutionPolicy, setRoomExecutionPolicy] = useState<CollaborationRoomExecutionPolicySnapshot | null>(null);
  const [reviewVisibilityPolicy, setReviewVisibilityPolicy] = useState<CollaborationReviewVisibilityPolicy | null>(null);
  const [hideReviewPrompts, setHideReviewPrompts] = useState(false);
  const [hideReviewModelParameters, setHideReviewModelParameters] = useState(false);
  const [policyAllowedModels, setPolicyAllowedModels] = useState('*');
  const [policyDailyCostLimit, setPolicyDailyCostLimit] = useState('0');
  const [policyPerRunCostLimit, setPolicyPerRunCostLimit] = useState('0');
  const [policyConcurrencyLimit, setPolicyConcurrencyLimit] = useState('2');
  const [roomAllowEditorRuns, setRoomAllowEditorRuns] = useState(true);
  const [roomMemberDailyRunLimit, setRoomMemberDailyRunLimit] = useState('0');
  const [roomCanvasConcurrencyLimit, setRoomCanvasConcurrencyLimit] = useState('1');
  const [roomAutoApproveLowRisk, setRoomAutoApproveLowRisk] = useState(false);
  const [roomHighCostConfirmationThreshold, setRoomHighCostConfirmationThreshold] = useState('0');
  const [roomRequireUnknownCostConfirmation, setRoomRequireUnknownCostConfirmation] = useState(true);
  const [auditPage, setAuditPage] = useState<CollaborationAuditPage>(EMPTY_AUDIT_PAGE);
  const [auditActionDraft, setAuditActionDraft] = useState('');
  const [auditActorDraft, setAuditActorDraft] = useState('');
  const [auditTargetTypeDraft, setAuditTargetTypeDraft] = useState('');
  const [auditFilters, setAuditFilters] = useState(EMPTY_AUDIT_FILTERS);
  const [auditOffset, setAuditOffset] = useState(0);
  const [auditReloadGeneration, setAuditReloadGeneration] = useState(0);
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditError, setAuditError] = useState('');
  const [selectedHost, setSelectedHost] = useState('');
  const [port, setPort] = useState(18767);
  const [shareBaseUrl, setShareBaseUrl] = useState('');
  const [publicBaseUrlDraft, setPublicBaseUrlDraft] = useState('');
  const [publicSelfCheck, setPublicSelfCheck] = useState<CollaborationPublicSelfCheck | null>(null);
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
  const auditLoadGenerationRef = useRef(0);
  const auditLoadAbortRef = useRef<AbortController | null>(null);
  const publicBaseUrlDirtyRef = useRef(false);
  const scopeKey = collaborationHostScopeKey(projectId, canvasId);
  const scopeFenceRef = useRef<ReturnType<typeof createCollaborationHostScopeFence> | null>(null);
  if (!scopeFenceRef.current) scopeFenceRef.current = createCollaborationHostScopeFence(scopeKey);
  scopeFenceRef.current.setScope(scopeKey);

  useEffect(() => {
    const fence = scopeFenceRef.current!;
    fence.mount();
    return () => {
      fence.unmount();
      loadAbortRef.current?.abort();
      auditLoadAbortRef.current?.abort();
    };
  }, []);

  const refresh = useCallback(async (
    quiet = false,
    requestScope: CollaborationHostScopeToken = scopeFenceRef.current!.capture(),
  ) => {
    const fence = scopeFenceRef.current!;
    if (requestScope.scopeKey !== scopeKey || !fence.isCurrent(requestScope)) return;
    const generation = ++loadGenerationRef.current;
    loadAbortRef.current?.abort();
    const controller = new AbortController();
    loadAbortRef.current = controller;
    if (!quiet) setLoading(true);
    setError('');
    try {
      const [nextStatus, nextInvites, nextMembers, nextSessions, nextRunIntents, nextExecutionPolicy, nextRoomExecutionPolicy, nextReviewVisibilityPolicy] = await Promise.all([
        api.getCollaborationStatus(projectId, canvasId, { signal: controller.signal }),
        canvasId ? api.listCollaborationInvites(projectId, canvasId, { signal: controller.signal }) : Promise.resolve([]),
        canvasId ? api.listCollaborationMembers(projectId, canvasId, { signal: controller.signal }) : Promise.resolve([]),
        canvasId ? api.listCollaborationSessions(projectId, canvasId, { signal: controller.signal }) : Promise.resolve([]),
        canvasId ? api.listCollaborationRunIntents('actionable', projectId, canvasId, { signal: controller.signal }) : Promise.resolve([]),
        api.getCollaborationExecutionPolicy(projectId, { signal: controller.signal }),
        canvasId
          ? api.getCollaborationRoomExecutionPolicy(projectId, canvasId, { signal: controller.signal })
          : Promise.resolve<CollaborationRoomExecutionPolicySnapshot | null>(null),
        api.getCollaborationReviewVisibilityPolicy(projectId, { signal: controller.signal }),
      ]);
      if (controller.signal.aborted
        || generation !== loadGenerationRef.current
        || !fence.isCurrent(requestScope)) return;
      setStatus(nextStatus);
      setInvites(nextInvites);
      setMembers(nextMembers);
      setSessions(nextSessions);
      setRunIntents(nextRunIntents.filter((intent) => !canvasId || intent.canvasId === canvasId));
      setExecutionPolicy(nextExecutionPolicy);
      setRoomExecutionPolicy(nextRoomExecutionPolicy);
      setReviewVisibilityPolicy(nextReviewVisibilityPolicy);
      if (!publicBaseUrlDirtyRef.current) setPublicBaseUrlDraft(nextStatus.publicBaseUrl || '');
      setPublicSelfCheck(nextStatus.lastPublicSelfCheck || null);
      setHideReviewPrompts(nextReviewVisibilityPolicy.hidePrompts);
      setHideReviewModelParameters(nextReviewVisibilityPolicy.hideModelParameters);
      setPolicyAllowedModels(nextExecutionPolicy.policy.allowedModels.join('\n'));
      setPolicyDailyCostLimit(String(nextExecutionPolicy.policy.dailyCostLimit));
      setPolicyPerRunCostLimit(String(nextExecutionPolicy.policy.perRunCostLimit));
      setPolicyConcurrencyLimit(String(nextExecutionPolicy.policy.concurrencyLimit));
      if (nextRoomExecutionPolicy) {
        setRoomAllowEditorRuns(nextRoomExecutionPolicy.policy.allowEditorRuns);
        setRoomMemberDailyRunLimit(String(nextRoomExecutionPolicy.policy.memberDailyRunLimit));
        setRoomCanvasConcurrencyLimit(String(nextRoomExecutionPolicy.policy.canvasConcurrencyLimit));
        setRoomAutoApproveLowRisk(nextRoomExecutionPolicy.policy.autoApproveLowRisk);
        setRoomHighCostConfirmationThreshold(String(nextRoomExecutionPolicy.policy.highCostConfirmationThreshold));
        setRoomRequireUnknownCostConfirmation(nextRoomExecutionPolicy.policy.requireUnknownCostConfirmation);
      }
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
      if (controller.signal.aborted || !fence.isCurrent(requestScope)) return;
      setError(refreshError instanceof Error ? refreshError.message : String(refreshError));
    } finally {
      if (generation === loadGenerationRef.current && fence.isCurrent(requestScope)) setLoading(false);
    }
  }, [canvasId, projectId, scopeKey]);

  useEffect(() => {
    setStatus(EMPTY_STATUS);
    setInvites([]);
    setMembers([]);
    setSessions([]);
    setRunIntents([]);
    setExecutionPolicy(null);
    setRoomExecutionPolicy(null);
    setReviewVisibilityPolicy(null);
    setHideReviewPrompts(false);
    setHideReviewModelParameters(false);
    setPolicyAllowedModels('*');
    setPolicyDailyCostLimit('0');
    setPolicyPerRunCostLimit('0');
    setPolicyConcurrencyLimit('2');
    setRoomAllowEditorRuns(true);
    setRoomMemberDailyRunLimit('0');
    setRoomCanvasConcurrencyLimit('1');
    setRoomAutoApproveLowRisk(false);
    setRoomHighCostConfirmationThreshold('0');
    setRoomRequireUnknownCostConfirmation(true);
    setAuditPage(EMPTY_AUDIT_PAGE);
    setAuditActionDraft('');
    setAuditActorDraft('');
    setAuditTargetTypeDraft('');
    setAuditFilters(EMPTY_AUDIT_FILTERS);
    setAuditOffset(0);
    setAuditError('');
    setSelectedHost('');
    setShareBaseUrl('');
    setPublicBaseUrlDraft('');
    setPublicSelfCheck(null);
    publicBaseUrlDirtyRef.current = false;
    setLatestInvite(null);
    setNotice('');
    setError('');
    setMutation(null);
    setLoading(false);
    setAuditLoading(false);
    setStopConfirm(false);
    setResourceScopeConfirm(false);
    setRevokeAllConfirm(false);
    setRemoveMemberConfirmId(null);
    setRevokeSessionConfirmId(null);
    const requestScope = scopeFenceRef.current!.capture();
    void refresh(false, requestScope);
    return () => {
      loadAbortRef.current?.abort();
      auditLoadAbortRef.current?.abort();
    };
  }, [refresh, scopeKey]);

  useEffect(() => {
    const requestScope = scopeFenceRef.current!.capture();
    const fence = scopeFenceRef.current!;
    const generation = ++auditLoadGenerationRef.current;
    auditLoadAbortRef.current?.abort();
    const controller = new AbortController();
    auditLoadAbortRef.current = controller;
    setAuditLoading(true);
    setAuditError('');
    void api.listCollaborationAuditEvents({
      projectId,
      canvasId,
      action: auditFilters.action || undefined,
      actorId: auditFilters.actorId || undefined,
      targetType: auditFilters.targetType || undefined,
      offset: auditOffset,
      limit: 25,
    }, { signal: controller.signal }).then((nextPage) => {
      if (!controller.signal.aborted
        && generation === auditLoadGenerationRef.current
        && fence.isCurrent(requestScope)) setAuditPage(nextPage);
    }).catch((loadError) => {
      if (!controller.signal.aborted
        && generation === auditLoadGenerationRef.current
        && fence.isCurrent(requestScope)) {
        setAuditError(loadError instanceof Error ? loadError.message : String(loadError));
      }
    }).finally(() => {
      if (!controller.signal.aborted
        && generation === auditLoadGenerationRef.current
        && fence.isCurrent(requestScope)) setAuditLoading(false);
    });
    return () => controller.abort();
  }, [auditFilters, auditOffset, auditReloadGeneration, canvasId, projectId]);

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
    const requestScope = scopeFenceRef.current!.capture();
    if (requestScope.scopeKey !== scopeKey || !scopeFenceRef.current!.isCurrent(requestScope)) return null;
    setMutation(key);
    setError('');
    setNotice('');
    const outcome = await runCollaborationHostScopedMutation({
      fence: scopeFenceRef.current!,
      token: requestScope,
      action,
      onSuccess: (result) => setNotice(typeof success === 'function' ? success(result) : success),
      refresh: (token) => refresh(true, token),
      onError: (mutationError) => setError(
        mutationError instanceof Error ? mutationError.message : String(mutationError),
      ),
      onSettled: () => setMutation(null),
    });
    return outcome.status === 'applied' ? outcome.value : null;
  }, [mutation, refresh, scopeKey]);

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
  const publicUrlRisk = useMemo(
    () => collaborationPublicUrlRisk(publicBaseUrlDraft),
    [publicBaseUrlDraft],
  );
  const insecurePublicWarning = publicUrlRisk.insecurePublic
    || Boolean(publicSelfCheck?.insecurePublic && publicSelfCheck.baseUrl === publicBaseUrlDraft.trim());
  const publicExposureConfiguration = status.publicExposureConfiguration;
  const persistentConfigurationWarning = publicExposureConfiguration?.warning || '';

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

  const runPublicSelfCheck = async () => {
    const baseUrl = publicBaseUrlDraft.trim();
    if (!status.running) {
      setError('请先启动协作网关，再执行公网自检。');
      return;
    }
    if (!collaborationPublicUrlRisk(baseUrl).valid) {
      setError('公网 Base URL 必须是以 /collab 结尾的 HTTP/HTTPS 地址，且不能包含查询参数或凭据。');
      return;
    }
    const result = await runMutation(
      'public-self-check',
      () => api.runCollaborationPublicSelfCheck(baseUrl),
      (next) => next.allChecksPassed
        ? next.status === 'degraded'
          ? '五项可达性检查通过，但公网 HTTP 已进入安全降级。'
          : '公网 health、邀请兑换、WebSocket、微型上传和 Range 全部通过。'
        : '公网自检完成，请按失败项逐一修复反向代理。',
    );
    if (result) {
      publicBaseUrlDirtyRef.current = false;
      setPublicBaseUrlDraft(result.baseUrl);
      setPublicSelfCheck(result);
    } else {
      // Configuration is durably stored before network probing. DNS/SSRF or
      // transport failures therefore still require a fresh status snapshot.
      await refresh(true, scopeFenceRef.current!.capture());
    }
  };

  const clearPublicBaseUrl = async () => {
    const result = await runMutation(
      'public-base-url-clear',
      api.clearCollaborationPublicBaseUrl,
      (next) => next.publicBaseUrl
        ? '已清除本机保存值，并恢复环境变量中的公网 Base URL。'
        : '已清除公网 Base URL；未知远程连接将保持安全降级。',
    );
    if (result) {
      publicBaseUrlDirtyRef.current = false;
      setStatus(result);
      setPublicBaseUrlDraft(result.publicBaseUrl || '');
      setPublicSelfCheck(null);
    }
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

  const acceptRunIntent = async (intent: RunIntent) => {
    if (!canvasId || !Number.isSafeInteger(intent.queueRevision) || Number(intent.queueRevision) < 1) {
      setError('运行请求缺少当前权威队列 revision，不能盲目确认。');
      return;
    }
    const result = await runMutation(
      `intent-accept:${intent.id}`,
      async () => {
        const accepted = await api.acceptCollaborationRunIntent(intent.id, projectId, canvasId, {
          expectedQueueRevision: Number(intent.queueRevision),
        });
        try {
          return { accepted, executionStarted: await onAcceptRunIntent(accepted), executionError: '' };
        } catch (executionError) {
          return {
            accepted,
            executionStarted: false,
            executionError: executionError instanceof Error ? executionError.message : String(executionError),
          };
        }
      },
      ({ accepted, executionStarted }) => executionStarted
        ? `运行请求已确认到 queue revision ${accepted.queueRevision}，本机执行器已开始处理。`
        : `运行请求已确认到 queue revision ${accepted.queueRevision}，可从队列再次显式执行。`,
    );
    if (result && (!result.executionStarted || result.executionError)) {
      setNotice('');
      setError(result.executionError || '运行请求已确认，但本机执行器尚未开始处理；请从队列再次执行。');
    }
  };

  const executeAcceptedRunIntent = async (intent: RunIntent) => {
    if (intent.status !== 'accepted' || intent.confirmationRequired === false) {
      setError('只有需要人工确认且已进入 accepted 的请求可以从这里显式执行。');
      return;
    }
    const started = await runMutation(
      `intent-execute:${intent.id}`,
      () => onAcceptRunIntent(intent),
      (executionStarted) => executionStarted ? '本机执行器已开始处理该请求。' : '本机执行器未能领取该请求。',
    );
    if (started === false) {
      setNotice('');
      setError('本机执行器未能领取该请求；已刷新权威队列，请核对 revision、租约或画布状态。');
    }
  };

  const cancelRunIntent = (intent: RunIntent) => {
    if (!canvasId || !Number.isSafeInteger(intent.queueRevision) || Number(intent.queueRevision) < 1) {
      setError('运行请求缺少当前权威队列 revision，不能盲目取消。');
      return;
    }
    void runMutation(
      `intent-cancel:${intent.id}`,
      () => api.cancelCollaborationRunIntent(intent.id, projectId, canvasId, {
        expectedQueueRevision: Number(intent.queueRevision),
      }),
      (cancelled) => cancelled.cancelRequestedAt && !cancelled.cancelledAt
        ? '已请求取消；执行器将在安全边界停止并释放租约。'
        : '运行请求已取消。',
    );
  };

  const saveExecutionPolicy = async () => {
    if (!policyDailyCostLimit.trim() || !policyPerRunCostLimit.trim() || !policyConcurrencyLimit.trim()) {
      setError('额度与并发输入不能为空；需要不限时请明确填写 0。');
      return;
    }
    const dailyCostLimit = Number(policyDailyCostLimit);
    const perRunCostLimit = Number(policyPerRunCostLimit);
    const concurrencyLimit = Number(policyConcurrencyLimit);
    if (!Number.isFinite(dailyCostLimit) || dailyCostLimit < 0 || dailyCostLimit > 1_000_000_000) {
      setError('每日额度必须是 0-1000000000 的数值；0 表示不限。');
      return;
    }
    if (!Number.isFinite(perRunCostLimit) || perRunCostLimit < 0 || perRunCostLimit > 1_000_000_000) {
      setError('单次成本上限必须是 0-1000000000 的数值；0 表示不限。');
      return;
    }
    if (!Number.isInteger(concurrencyLimit) || concurrencyLimit < 1 || concurrencyLimit > 64) {
      setError('并发上限必须是 1-64 的整数。');
      return;
    }
    const allowedModels = [...new Set(policyAllowedModels
      .split(/[\n,]/)
      .map((value) => value.trim())
      .filter(Boolean))];
    if (allowedModels.length > 500 || allowedModels.some((value) => value.length > 160 || /[\u0000-\u001f\u007f]/.test(value))) {
      setError('模型白名单最多 500 项，每项最多 160 字符且不能包含控制字符。');
      return;
    }
    const saved = await runMutation(
      'execution-policy-save',
      () => api.updateCollaborationExecutionPolicy(projectId, {
        allowedModels,
        dailyCostLimit,
        perRunCostLimit,
        concurrencyLimit,
      }),
      (policy) => `执行策略已保存：${policy.allowedModels.includes('*') ? '模型不限' : `${policy.allowedModels.length} 个允许模型`}，并发上限 ${policy.concurrencyLimit}。`,
    );
    if (saved) {
      setAuditOffset(0);
      setAuditReloadGeneration((value) => value + 1);
    }
  };

  const saveRoomExecutionPolicy = async () => {
    if (!canvasId || !roomExecutionPolicy
      || !Number.isSafeInteger(roomExecutionPolicy.policy.revision)
      || roomExecutionPolicy.policy.revision < 0) {
      setError('当前画布执行策略尚未完成权威载入，不能盲写。');
      return;
    }
    const memberDailyRunLimit = Number(roomMemberDailyRunLimit);
    const canvasConcurrencyLimit = Number(roomCanvasConcurrencyLimit);
    const highCostConfirmationThreshold = Number(roomHighCostConfirmationThreshold);
    if (!Number.isSafeInteger(memberDailyRunLimit) || memberDailyRunLimit < 0 || memberDailyRunLimit > 100_000) {
      setError('成员每日运行上限必须是 0-100000 的整数；0 表示不限。');
      return;
    }
    if (!Number.isSafeInteger(canvasConcurrencyLimit) || canvasConcurrencyLimit < 1 || canvasConcurrencyLimit > 64) {
      setError('画布并发上限必须是 1-64 的整数。');
      return;
    }
    if (!Number.isFinite(highCostConfirmationThreshold)
      || highCostConfirmationThreshold < 0
      || highCostConfirmationThreshold > 1_000_000_000) {
      setError('高费用确认阈值必须是 0-1000000000 的数值；0 表示不按已知费用自动加确认。');
      return;
    }
    const saved = await runMutation(
      'room-execution-policy-save',
      () => api.updateCollaborationRoomExecutionPolicy(projectId, canvasId, {
        expectedRevision: roomExecutionPolicy.policy.revision,
        allowEditorRuns: roomAllowEditorRuns,
        memberDailyRunLimit,
        canvasConcurrencyLimit,
        autoApproveLowRisk: roomAutoApproveLowRisk,
        highCostConfirmationThreshold,
        requireUnknownCostConfirmation: roomRequireUnknownCostConfirmation,
      }),
      (policy) => `当前画布执行策略已保存到 revision ${policy.revision}。`,
    );
    if (saved) {
      setAuditOffset(0);
      setAuditReloadGeneration((value) => value + 1);
    }
  };

  const saveReviewVisibilityPolicy = async () => {
    if (!reviewVisibilityPolicy || !Number.isSafeInteger(reviewVisibilityPolicy.revision)
      || reviewVisibilityPolicy.revision < 0) {
      setError('审片可见性策略尚未完成权威载入，不能盲写。');
      return;
    }
    const saved = await runMutation(
      'review-visibility-policy-save',
      () => api.updateCollaborationReviewVisibilityPolicy(projectId, {
        expectedRevision: reviewVisibilityPolicy.revision,
        hidePrompts: hideReviewPrompts,
        hideModelParameters: hideReviewModelParameters,
      }),
      (policy) => `审片可见性策略已保存到 revision ${policy.revision}。`,
    );
    if (saved) {
      setAuditOffset(0);
      setAuditReloadGeneration((value) => value + 1);
    }
  };

  const applyAuditFilters = () => {
    setAuditOffset(0);
    setAuditFilters({
      action: auditActionDraft.trim(),
      actorId: auditActorDraft.trim(),
      targetType: auditTargetTypeDraft.trim(),
    });
    setAuditReloadGeneration((value) => value + 1);
  };

  const clearAuditFilters = () => {
    setAuditActionDraft('');
    setAuditActorDraft('');
    setAuditTargetTypeDraft('');
    setAuditOffset(0);
    setAuditFilters(EMPTY_AUDIT_FILTERS);
    setAuditReloadGeneration((value) => value + 1);
  };

  const refreshAll = () => {
    void refresh();
    setAuditReloadGeneration((value) => value + 1);
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
          <button type="button" className="grid h-8 w-8 place-items-center rounded border border-[var(--border-primary)] disabled:opacity-40" disabled={loading || Boolean(mutation)} title="刷新协作状态" onClick={refreshAll}>
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

      <div className="rounded border border-[var(--border-primary)] p-4" data-testid="collaboration-public-self-check">
        <div className="mb-3">
          <h4 className="flex items-center gap-2 text-xs font-bold"><Globe2 size={14} />公网 Base URL 与反向代理自检</h4>
          <p className="mt-1 text-[10px] leading-5 text-[var(--text-secondary)]">填写外部访问页面（路径以 /collab 结尾）。自检逐项验证 health、邀请兑换、WebSocket Upgrade、微型上传与 Range；只使用短时单次内存探针，不创建长期邀请、素材或项目数据。</p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            value={publicBaseUrlDraft}
            inputMode="url"
            maxLength={2048}
            placeholder="https://collab.example.com/collab"
            aria-label="公网 Base URL"
            className="h-10 min-w-0 flex-1 rounded border border-[var(--border-primary)] bg-[var(--bg-secondary)] px-3 text-xs"
            onChange={(event) => {
              publicBaseUrlDirtyRef.current = true;
              setPublicBaseUrlDraft(event.target.value);
              if (publicSelfCheck?.baseUrl !== event.target.value.trim()) setPublicSelfCheck(null);
            }}
          />
          <button
            type="button"
            className="flex h-10 shrink-0 items-center justify-center gap-2 rounded bg-[var(--accent-primary)] px-4 text-xs font-bold text-white disabled:opacity-40"
            disabled={!status.running || !publicBaseUrlDraft.trim() || Boolean(mutation)}
            onClick={() => void runPublicSelfCheck()}
          >
            {mutation === 'public-self-check' ? <Loader2 size={14} className="animate-spin" /> : <ShieldCheck size={14} />}
            {mutation === 'public-self-check' ? '正在逐项自检…' : '运行五项自检'}
          </button>
          {publicExposureConfiguration?.canClearPersisted && (
            <button
              type="button"
              className="flex h-10 shrink-0 items-center justify-center gap-2 rounded border border-[var(--border-primary)] px-3 text-xs font-bold disabled:opacity-40"
              disabled={Boolean(mutation)}
              onClick={() => void clearPublicBaseUrl()}
            >
              <Trash2 size={14} />
              {mutation === 'public-base-url-clear' ? '清除中…' : '清除保存值'}
            </button>
          )}
        </div>
        {persistentConfigurationWarning && (
          <div
            className={`mt-3 rounded border p-3 text-xs leading-5 ${publicExposureConfiguration?.status === 'invalid' ? 'border-red-500/45 bg-red-500/10 text-red-600' : 'border-amber-500/40 bg-amber-500/10 text-amber-700'}`}
            data-testid="collaboration-public-exposure-configuration-warning"
          >
            <div className="flex items-start gap-2"><AlertTriangle size={16} className="mt-0.5 shrink-0" /><div><div className="font-bold">公网配置状态：{publicExposureConfiguration?.status === 'invalid' ? '配置不可用' : '安全降级'}</div><p className="mt-1">{persistentConfigurationWarning}</p>{publicExposureConfiguration?.errorCode && <p className="mt-1 font-mono text-[10px]">{publicExposureConfiguration.errorCode}</p>}</div></div>
          </div>
        )}
        {insecurePublicWarning && (
          <div className="mt-3 rounded border border-red-500/45 bg-red-500/10 p-3 text-xs leading-5 text-red-600" data-testid="collaboration-public-http-warning">
            <div className="flex items-start gap-2"><AlertTriangle size={16} className="mt-0.5 shrink-0" /><div><div className="font-bold">公网 HTTP 持续风险：安全能力已降级</div><p className="mt-1">服务端将禁止 owner 管理能力和敏感原件下载。请配置有效 HTTPS；局域网与本机开发地址不受此降级影响。</p></div></div>
          </div>
        )}
        {publicSelfCheck && (
          <div className="mt-3 space-y-2" data-testid="collaboration-public-self-check-results">
            <div className={`rounded border p-3 text-xs ${publicSelfCheck.allChecksPassed ? 'border-green-500/35 bg-green-500/10 text-green-600' : 'border-amber-500/40 bg-amber-500/10 text-amber-700'}`}>
              {publicSelfCheck.allChecksPassed ? '五项网络链路均可达' : '部分网络链路未通过'} · {publicSelfCheck.protocol.toUpperCase()} · {formatTime(publicSelfCheck.completedAt)}
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              {publicSelfCheck.checks.map((check) => (
                <div key={check.id} className={`rounded border p-3 text-[11px] leading-5 ${check.status === 'passed' ? 'border-green-500/30' : 'border-red-500/35 bg-red-500/5'}`}>
                  <div className="flex items-center justify-between gap-2"><span className="font-bold">{PUBLIC_SELF_CHECK_LABELS[check.id]}</span><span className={check.status === 'passed' ? 'text-green-600' : 'text-red-500'}>{check.status === 'passed' ? `通过 · ${check.latencyMs} ms` : '失败'}</span></div>
                  {check.status === 'failed' && <p className="mt-1 text-red-500">{check.message}</p>}
                  <p className="mt-1 text-[var(--text-secondary)]">{check.hint}</p>
                </div>
              ))}
            </div>
          </div>
        )}
        <p className="mt-3 text-[10px] leading-5 text-[var(--text-secondary)]">T8 不会自动开放 Windows 防火墙、启用 UPnP 或保存路由器账号；这里只验证你明确填写的入口。</p>
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

      <div className="rounded border border-[var(--border-primary)] p-4" data-testid="collaboration-execution-policy-management">
        <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h4 className="flex items-center gap-2 text-xs font-bold"><SlidersHorizontal size={14} />主机代执行策略</h4>
            <p className="mt-1 text-[10px] leading-5 text-[var(--text-secondary)]">策略只在本机管理端配置；协作者只能提交运行意图，不能读取或改写此配置，更不会获得 API Key。</p>
          </div>
          <div className="text-right text-[10px] leading-5 text-[var(--text-secondary)]">
            <div>今日已计成本：{executionPolicy?.usage.dailyCost ?? 0}</div>
            <div>活动意图：{executionPolicy?.usage.activeCount ?? 0} · 排队：{executionPolicy?.usage.queuedCount ?? 0} · 未知成本：{executionPolicy?.usage.unknownCostCount ?? 0}</div>
          </div>
        </div>
        <div className="mb-3 grid gap-2 sm:grid-cols-4">
          <div className="rounded bg-[var(--bg-secondary)] p-2 text-[10px]"><span className="text-[var(--text-secondary)]">模型范围</span><div className="mt-1 font-bold">{executionPolicy?.policy.allowedModels.includes('*') ? '不限（*）' : executionPolicy?.policy.allowedModels.length ? `${executionPolicy.policy.allowedModels.length} 个白名单模型` : '全部禁止'}</div></div>
          <div className="rounded bg-[var(--bg-secondary)] p-2 text-[10px]"><span className="text-[var(--text-secondary)]">每日额度</span><div className="mt-1 font-bold">{formatPolicyLimit(executionPolicy?.policy.dailyCostLimit)}</div></div>
          <div className="rounded bg-[var(--bg-secondary)] p-2 text-[10px]"><span className="text-[var(--text-secondary)]">单次成本</span><div className="mt-1 font-bold">{formatPolicyLimit(executionPolicy?.policy.perRunCostLimit)}</div></div>
          <div className="rounded bg-[var(--bg-secondary)] p-2 text-[10px]"><span className="text-[var(--text-secondary)]">并发上限</span><div className="mt-1 font-bold">{executionPolicy?.policy.concurrencyLimit ?? 2}</div></div>
        </div>
        <div className="rounded border border-amber-500/35 bg-amber-500/10 p-3 text-[10px] leading-5 text-amber-700">
          默认策略中 <strong>* 表示模型不限</strong>，每日额度与单次成本的 <strong>0 表示不限</strong>；空白模型列表表示禁止所有模型。并发始终有限，范围为 1-64，默认 2。
        </div>
        <div className="mt-3 grid gap-3 lg:grid-cols-[minmax(0,1.5fr)_repeat(3,minmax(120px,0.5fr))]">
          <label className="text-xs font-semibold">模型白名单（每行或逗号一项）
            <textarea
              value={policyAllowedModels}
              rows={4}
              spellCheck={false}
              className="mt-1 w-full rounded border border-[var(--border-primary)] bg-[var(--bg-secondary)] px-3 py-2 font-mono text-[11px]"
              placeholder="*"
              onChange={(event) => setPolicyAllowedModels(event.target.value)}
            />
          </label>
          <label className="text-xs font-semibold">每日额度（0 = 不限）
            <input type="number" min={0} max={1_000_000_000} step="any" value={policyDailyCostLimit} className="mt-1 h-10 w-full rounded border border-[var(--border-primary)] bg-[var(--bg-secondary)] px-3" onChange={(event) => setPolicyDailyCostLimit(event.target.value)} />
          </label>
          <label className="text-xs font-semibold">单次成本（0 = 不限）
            <input type="number" min={0} max={1_000_000_000} step="any" value={policyPerRunCostLimit} className="mt-1 h-10 w-full rounded border border-[var(--border-primary)] bg-[var(--bg-secondary)] px-3" onChange={(event) => setPolicyPerRunCostLimit(event.target.value)} />
          </label>
          <label className="text-xs font-semibold">并发上限（1-64）
            <input type="number" min={1} max={64} step={1} value={policyConcurrencyLimit} className="mt-1 h-10 w-full rounded border border-[var(--border-primary)] bg-[var(--bg-secondary)] px-3" onChange={(event) => setPolicyConcurrencyLimit(event.target.value)} />
          </label>
        </div>
        <button type="button" className="mt-3 h-10 w-full rounded bg-[var(--accent-primary)] px-4 text-xs font-bold text-white disabled:opacity-40" disabled={Boolean(mutation) || loading} onClick={() => void saveExecutionPolicy()}>
          {mutation === 'execution-policy-save' ? '保存中…' : '保存主机执行策略'}
        </button>
      </div>

      <div className="rounded border border-[var(--border-primary)] p-4" data-testid="collaboration-room-execution-policy">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h4 className="flex items-center gap-2 text-xs font-bold"><SlidersHorizontal size={14} />当前画布运行队列策略</h4>
            <p className="mt-1 text-[10px] leading-5 text-[var(--text-secondary)]">策略由本机管理接口按 revision 完整提交；低风险自动确认仍由服务端重新校验权限、费用和并发，浏览器不能自行放行。</p>
          </div>
          <div className="text-right text-[10px] leading-5 text-[var(--text-secondary)]">
            <div>revision {roomExecutionPolicy?.policy.revision ?? '—'}</div>
            <div>活动 {roomExecutionPolicy?.usage.activeCount ?? 0} · 排队 {roomExecutionPolicy?.usage.queuedCount ?? 0} · 本成员今日 {roomExecutionPolicy?.usage.requestedByDailyCount ?? 0}</div>
          </div>
        </div>
        <div className="mt-3 grid gap-2 lg:grid-cols-3">
          <label className="flex items-start gap-3 rounded border border-[var(--border-primary)] bg-[var(--bg-secondary)] p-3 text-xs">
            <input type="checkbox" className="mt-0.5" checked={roomAllowEditorRuns} disabled={!roomExecutionPolicy || Boolean(mutation)} onChange={(event) => setRoomAllowEditorRuns(event.target.checked)} />
            <span><strong>允许编辑者提交运行</strong><span className="mt-1 block text-[10px] leading-4 text-[var(--text-secondary)]">关闭后只有房间所有者能创建新的运行意图。</span></span>
          </label>
          <label className="flex items-start gap-3 rounded border border-[var(--border-primary)] bg-[var(--bg-secondary)] p-3 text-xs">
            <input type="checkbox" className="mt-0.5" checked={roomAutoApproveLowRisk} disabled={!roomExecutionPolicy || Boolean(mutation)} onChange={(event) => setRoomAutoApproveLowRisk(event.target.checked)} />
            <span><strong>自动确认低风险请求</strong><span className="mt-1 block text-[10px] leading-4 text-[var(--text-secondary)]">仅服务端判定无需人工确认时自动进入等待调度状态。</span></span>
          </label>
          <label className="flex items-start gap-3 rounded border border-[var(--border-primary)] bg-[var(--bg-secondary)] p-3 text-xs">
            <input type="checkbox" className="mt-0.5" checked={roomRequireUnknownCostConfirmation} disabled={!roomExecutionPolicy || Boolean(mutation)} onChange={(event) => setRoomRequireUnknownCostConfirmation(event.target.checked)} />
            <span><strong>未知费用必须人工确认</strong><span className="mt-1 block text-[10px] leading-4 text-[var(--text-secondary)]">无法可靠估价时保持待确认，不让自动策略绕过费用风险。</span></span>
          </label>
        </div>
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <label className="text-xs font-semibold">成员每日运行上限（0 = 不限）
            <input type="number" min={0} max={100_000} step={1} value={roomMemberDailyRunLimit} disabled={!roomExecutionPolicy || Boolean(mutation)} className="mt-1 h-10 w-full rounded border border-[var(--border-primary)] bg-[var(--bg-secondary)] px-3 disabled:opacity-60" onChange={(event) => setRoomMemberDailyRunLimit(event.target.value)} />
          </label>
          <label className="text-xs font-semibold">画布并发上限（1-64）
            <input type="number" min={1} max={64} step={1} value={roomCanvasConcurrencyLimit} disabled={!roomExecutionPolicy || Boolean(mutation)} className="mt-1 h-10 w-full rounded border border-[var(--border-primary)] bg-[var(--bg-secondary)] px-3 disabled:opacity-60" onChange={(event) => setRoomCanvasConcurrencyLimit(event.target.value)} />
          </label>
          <label className="text-xs font-semibold">高费用确认阈值（0 = 不启用）
            <input type="number" min={0} max={1_000_000_000} step="any" value={roomHighCostConfirmationThreshold} disabled={!roomExecutionPolicy || Boolean(mutation)} className="mt-1 h-10 w-full rounded border border-[var(--border-primary)] bg-[var(--bg-secondary)] px-3 disabled:opacity-60" onChange={(event) => setRoomHighCostConfirmationThreshold(event.target.value)} />
          </label>
        </div>
        <button type="button" className="mt-3 h-10 w-full rounded bg-[var(--accent-primary)] px-4 text-xs font-bold text-white disabled:opacity-40" disabled={!canvasId || !roomExecutionPolicy || Boolean(mutation) || loading} onClick={() => void saveRoomExecutionPolicy()}>
          {mutation === 'room-execution-policy-save' ? '保存中…' : '按当前 revision 保存完整画布策略'}
        </button>
      </div>

      <div className="rounded border border-[var(--border-primary)] p-4" data-testid="collaboration-review-visibility-policy">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h4 className="flex items-center gap-2 text-xs font-bold"><ShieldCheck size={14} />远程审片可见性</h4>
            <p className="mt-1 text-[10px] leading-5 text-[var(--text-secondary)]">仅 owner 可在本机管理端修改。公开审片接口仍由服务端按此策略裁剪，前端开关不能伪造权限。</p>
          </div>
          <span className="text-[10px] text-[var(--text-secondary)]">revision {reviewVisibilityPolicy?.revision ?? '—'}</span>
        </div>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <label className="flex items-start gap-3 rounded border border-[var(--border-primary)] bg-[var(--bg-secondary)] p-3 text-xs">
            <input type="checkbox" className="mt-0.5" checked={hideReviewPrompts} disabled={!reviewVisibilityPolicy || Boolean(mutation)} onChange={(event) => setHideReviewPrompts(event.target.checked)} />
            <span><strong>对远程审片隐藏 Prompt</strong><span className="mt-1 block text-[10px] leading-4 text-[var(--text-secondary)]">评论和版本结构仍可见，但不向 reviewer/viewer 返回节点 Prompt 正文。</span></span>
          </label>
          <label className="flex items-start gap-3 rounded border border-[var(--border-primary)] bg-[var(--bg-secondary)] p-3 text-xs">
            <input type="checkbox" className="mt-0.5" checked={hideReviewModelParameters} disabled={!reviewVisibilityPolicy || Boolean(mutation)} onChange={(event) => setHideReviewModelParameters(event.target.checked)} />
            <span><strong>对远程审片隐藏模型参数</strong><span className="mt-1 block text-[10px] leading-4 text-[var(--text-secondary)]">Provider、模型及生成参数由主机公开视图统一移除，不依赖浏览器自行隐藏。</span></span>
          </label>
        </div>
        <button type="button" className="mt-3 h-10 w-full rounded bg-[var(--accent-primary)] px-4 text-xs font-bold text-white disabled:opacity-40" disabled={!reviewVisibilityPolicy || Boolean(mutation) || loading} onClick={() => void saveReviewVisibilityPolicy()}>
          {mutation === 'review-visibility-policy-save' ? '保存中…' : '保存审片可见性策略'}
        </button>
      </div>

      <div className="rounded border border-[var(--border-primary)] p-4" data-testid="collaboration-run-intents">
        <div className="mb-3 flex items-center justify-between"><div><h4 className="flex items-center gap-2 text-xs font-bold"><Play size={14} />运行请求队列</h4><p className="mt-1 text-[10px] leading-5 text-[var(--text-secondary)]">确认只会推进权威队列；执行器随后以一次性租约领取。租约凭据只留在执行器内存，不进入界面、项目文件或运行摘要。</p></div><span className="text-[10px] text-[var(--text-secondary)]">{runIntents.length}</span></div>
        <div className="space-y-2">
          {runIntents.map((intent) => {
            const queueRevisionReady = Number.isSafeInteger(intent.queueRevision) && Number(intent.queueRevision) >= 1;
                    const canConfirm = intent.status === 'pending' && intent.confirmationRequired !== false;
                    const canExecuteAccepted = intent.status === 'accepted' && intent.confirmationRequired !== false;
            const canCancel = ['pending', 'accepted', 'dispatching', 'running'].includes(intent.status)
              && !intent.cancelledAt;
            const lastErrorCode = intent.lastErrorCode || intent.lastError?.code || '';
            const lastErrorMessage = intent.lastErrorMessage || intent.lastError?.message || '';
            return (
              <article key={intent.id} className="rounded border border-[var(--border-primary)] bg-[var(--bg-secondary)] p-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2 text-xs"><strong className="break-all">{intent.requestedBy}</strong><span className="rounded bg-[var(--bg-primary)] px-2 py-0.5 text-[10px] font-bold">{intent.status}</span>{intent.confirmationRequired && <span className="text-[10px] font-bold text-amber-600">需要人工确认</span>}</div>
                    <div className="mt-1 text-[10px] leading-5 text-[var(--text-secondary)]">画布 revision {intent.canvasRevision} · queue revision {intent.queueRevision ?? '缺失'} · {intent.nodeIds.length || '全部'} 节点 · 创建 {formatTime(intent.createdAt)}</div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {canConfirm && <button type="button" className="h-8 rounded bg-[var(--accent-primary)] px-3 text-[11px] font-bold text-white disabled:opacity-40" disabled={Boolean(mutation) || !queueRevisionReady} onClick={() => void acceptRunIntent(intent)}>{mutation === `intent-accept:${intent.id}` ? '确认并启动中…' : '确认并执行'}</button>}
                    {canExecuteAccepted && <button type="button" className="h-8 rounded bg-[var(--accent-primary)] px-3 text-[11px] font-bold text-white disabled:opacity-40" disabled={Boolean(mutation) || !queueRevisionReady} onClick={() => void executeAcceptedRunIntent(intent)}>{mutation === `intent-execute:${intent.id}` ? '启动中…' : '执行已确认请求'}</button>}
                    {canCancel && <button type="button" className="h-8 rounded border border-red-500/45 px-3 text-[11px] font-bold text-red-500 disabled:opacity-40" disabled={Boolean(mutation) || !queueRevisionReady || Boolean(intent.cancelRequestedAt)} onClick={() => cancelRunIntent(intent)}>{mutation === `intent-cancel:${intent.id}` ? '取消中…' : intent.status === 'running' || intent.status === 'dispatching' ? '请求停止' : '取消请求'}</button>}
                  </div>
                </div>
                <div className="mt-3 grid gap-2 text-[10px] sm:grid-cols-2 lg:grid-cols-4">
                  <div className="rounded bg-[var(--bg-primary)] p-2"><span className="text-[var(--text-secondary)]">确认状态</span><div className="mt-1 font-bold">{intent.confirmationRequired ? '待人工确认' : intent.confirmedAt ? `已确认 · ${formatTime(intent.confirmedAt)}` : '无需人工确认'}</div></div>
                  <div className="rounded bg-[var(--bg-primary)] p-2"><span className="text-[var(--text-secondary)]">调度尝试</span><div className="mt-1 font-bold">{intent.dispatchAttempts ?? 0} 次</div></div>
                  <div className="rounded bg-[var(--bg-primary)] p-2"><span className="text-[var(--text-secondary)]">下次尝试</span><div className="mt-1 font-bold">{formatTime(intent.nextAttemptAt)}</div></div>
                  <div className="rounded bg-[var(--bg-primary)] p-2"><span className="text-[var(--text-secondary)]">租约到期</span><div className="mt-1 font-bold">{formatTime(intent.leaseExpiresAt)}</div></div>
                </div>
                {(intent.cancelRequestedAt || intent.cancelledAt) && <div className="mt-2 rounded border border-amber-500/30 bg-amber-500/10 p-2 text-[10px] text-amber-700">取消请求 {formatTime(intent.cancelRequestedAt)} · 完成取消 {formatTime(intent.cancelledAt)}</div>}
                {(lastErrorCode || lastErrorMessage) && <div className="mt-2 rounded border border-red-500/30 bg-red-500/10 p-2 text-[10px] text-red-500">最近错误{lastErrorCode ? ` ${lastErrorCode}` : ''}{lastErrorMessage ? `：${lastErrorMessage}` : ''}</div>}
              </article>
            );
          })}
          {!runIntents.length && !loading && <div className="py-5 text-center text-xs text-[var(--text-secondary)]">暂无远程运行请求</div>}
        </div>
      </div>

      <div className="rounded border border-[var(--border-primary)] p-4" data-testid="collaboration-audit-events">
        <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h4 className="flex items-center gap-2 text-xs font-bold"><ScrollText size={14} />协作审计</h4>
            <p className="mt-1 text-[10px] leading-5 text-[var(--text-secondary)]">仅本机管理端可查询。结果限定在最近 {auditPage.pagination.windowLimit} 条事件窗口，session 只显示不可逆摘要，路径、凭据和签名参数由服务端脱敏。</p>
          </div>
          <span className="text-[10px] text-[var(--text-secondary)]">窗口内匹配 {auditPage.pagination.totalWithinWindow} 条</span>
        </div>
        <div className="grid gap-2 sm:grid-cols-3">
          <label className="text-[10px] font-semibold">动作（精确）
            <input value={auditActionDraft} maxLength={120} placeholder="collaboration.member.remove" className="mt-1 h-9 w-full rounded border border-[var(--border-primary)] bg-[var(--bg-secondary)] px-2 text-[11px]" onChange={(event) => setAuditActionDraft(event.target.value)} />
          </label>
          <label className="text-[10px] font-semibold">操作者 ID（精确）
            <input value={auditActorDraft} maxLength={240} placeholder="local-owner" className="mt-1 h-9 w-full rounded border border-[var(--border-primary)] bg-[var(--bg-secondary)] px-2 text-[11px]" onChange={(event) => setAuditActorDraft(event.target.value)} />
          </label>
          <label className="text-[10px] font-semibold">目标类型（精确）
            <input value={auditTargetTypeDraft} maxLength={80} placeholder="project / member / session" className="mt-1 h-9 w-full rounded border border-[var(--border-primary)] bg-[var(--bg-secondary)] px-2 text-[11px]" onChange={(event) => setAuditTargetTypeDraft(event.target.value)} />
          </label>
        </div>
        <div className="mt-2 flex gap-2">
          <button type="button" className="h-9 flex-1 rounded border border-[var(--border-primary)] px-3 text-[11px] font-bold disabled:opacity-40" disabled={auditLoading} onClick={applyAuditFilters}>查询</button>
          <button type="button" className="h-9 rounded border border-[var(--border-primary)] px-3 text-[11px] disabled:opacity-40" disabled={auditLoading} onClick={clearAuditFilters}>清除筛选</button>
        </div>
        {auditError && <div role="alert" className="mt-3 rounded border border-red-500/40 bg-red-500/10 p-3 text-xs text-red-500">{auditError}</div>}
        {auditPage.pagination.sourceTruncated && (
          <div className="mt-3 rounded border border-amber-500/35 bg-amber-500/10 p-2 text-[10px] text-amber-700">事件总量超过本次安全查询窗口；请使用精确动作、操作者或目标类型缩小范围。</div>
        )}
        <div className="mt-3 max-h-[34rem] space-y-2 overflow-auto">
          {auditPage.events.map((event) => (
            <article key={event.id} className="rounded border border-[var(--border-primary)] bg-[var(--bg-secondary)] p-3 text-[11px]">
              <div className="flex flex-wrap items-start justify-between gap-2"><strong className="break-all">{event.action}</strong><span className="text-[10px] text-[var(--text-secondary)]">#{event.id} · {formatTime(event.createdAt)}</span></div>
              <div className="mt-1 break-all text-[10px] text-[var(--text-secondary)]">actor {event.actorId || '—'} · session {event.sessionRef || '—'} · {event.targetType || 'target'} {event.targetId || '—'}</div>
              {event.metadata && Object.keys(event.metadata).length > 0 && <pre className="mt-2 max-h-36 overflow-auto whitespace-pre-wrap break-all rounded bg-[var(--bg-primary)] p-2 text-[10px]">{JSON.stringify(event.metadata, null, 2)}</pre>}
            </article>
          ))}
          {!auditPage.events.length && !auditLoading && !auditError && <div className="py-5 text-center text-xs text-[var(--text-secondary)]">当前筛选没有审计事件</div>}
          {auditLoading && <div className="flex items-center justify-center gap-2 py-5 text-xs text-[var(--text-secondary)]"><Loader2 size={14} className="animate-spin" />正在读取审计事件</div>}
        </div>
        <div className="mt-3 flex items-center justify-between gap-3">
          <button type="button" className="h-8 rounded border border-[var(--border-primary)] px-3 text-[10px] disabled:opacity-30" disabled={auditLoading || auditOffset <= 0} onClick={() => setAuditOffset(Math.max(0, auditOffset - auditPage.pagination.limit))}>上一页</button>
          <span className="text-[10px] text-[var(--text-secondary)]">{auditPage.pagination.totalWithinWindow ? `${auditOffset + 1}-${auditOffset + auditPage.events.length}` : '0'} / {auditPage.pagination.totalWithinWindow}</span>
          <button type="button" className="h-8 rounded border border-[var(--border-primary)] px-3 text-[10px] disabled:opacity-30" disabled={auditLoading || auditPage.pagination.nextOffset == null} onClick={() => setAuditOffset(auditPage.pagination.nextOffset ?? auditOffset)}>下一页</button>
        </div>
      </div>
    </section>
  );
}
