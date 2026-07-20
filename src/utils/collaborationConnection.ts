export const COLLABORATION_RECONNECT_BASE_MS = 500;
export const COLLABORATION_RECONNECT_MAX_MS = 15_000;
export const COLLABORATION_RECONNECT_JITTER = 0.2;
export const COLLABORATION_PROTOCOL_VERSION = 2;
export const COLLABORATION_HEARTBEAT_INTERVAL_MS = 5_000;
export const COLLABORATION_HEARTBEAT_TIMEOUT_MS = 15_000;
export const COLLABORATION_SESSION_HEARTBEAT_INTERVAL_MS = 60_000;
export const COLLABORATION_HANDSHAKE_TIMEOUT_MS = 15_000;
export const COLLABORATION_REQUEST_TIMEOUT_MS = 20_000;

export type CollaborationConnectionPhase =
  | 'bootstrapping'
  | 'connecting'
  | 'joining'
  | 'syncing'
  | 'online'
  | 'reconnecting'
  | 'offline'
  | 'host-stopped'
  | 'revoked'
  | 'blocked';

export interface CollaborationCloseDecision {
  action: 'retry' | 'refresh-session' | 'stop';
  phase: CollaborationConnectionPhase;
  message: string;
  retryAfterMs?: number;
}

export interface CollaborationGatewayNotice {
  reason?: string;
  retryable?: boolean;
  retryAfterMs?: number;
}

export interface CollaborationProtocolSettings {
  version: number;
  heartbeatIntervalMs: number;
  heartbeatTimeoutMs: number;
  maxSyncOperations: number;
}

export interface CollaborationSessionHeartbeatIdentity {
  sessionId: string;
  projectId: string;
  canvasId: string;
  memberId: string;
  authorizationEpoch: number;
}

export type CollaborationSessionHeartbeatFailureAction =
  | 'revoke'
  | 'block'
  | 'refresh-session'
  | 'ignore';

const SESSION_HEARTBEAT_TEXT_FIELDS = [
  ['sessionId', 'id'],
  ['projectId', 'projectId'],
  ['canvasId', 'canvasId'],
  ['memberId', 'memberId'],
] as const;

export function collaborationSessionHeartbeatIdentity(
  value: unknown,
): CollaborationSessionHeartbeatIdentity | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const identity = {} as CollaborationSessionHeartbeatIdentity;
  for (const [targetField, sourceField] of SESSION_HEARTBEAT_TEXT_FIELDS) {
    const text = source[sourceField];
    if (typeof text !== 'string'
      || text.length < 1
      || text.length > 240
      || text.trim() !== text
      || /[\u0000-\u001f\u007f]/.test(text)) return null;
    identity[targetField] = text;
  }
  if (!Number.isSafeInteger(source.authorizationEpoch)
    || Number(source.authorizationEpoch) < 1) return null;
  identity.authorizationEpoch = Number(source.authorizationEpoch);
  return identity;
}

export function sameCollaborationSessionHeartbeatIdentity(
  left: CollaborationSessionHeartbeatIdentity | null | undefined,
  right: CollaborationSessionHeartbeatIdentity | null | undefined,
) {
  return Boolean(left && right)
    && left?.sessionId === right?.sessionId
    && left?.projectId === right?.projectId
    && left?.canvasId === right?.canvasId
    && left?.memberId === right?.memberId
    && left?.authorizationEpoch === right?.authorizationEpoch;
}

export function classifyCollaborationSessionHeartbeatFailure(
  errorOrStatus: unknown,
): CollaborationSessionHeartbeatFailureAction {
  const status = typeof errorOrStatus === 'number'
    ? errorOrStatus
    : Number((errorOrStatus as { status?: unknown } | null)?.status);
  if (status === 401) return 'revoke';
  if (status === 403) return 'block';
  if (status === 409) return 'refresh-session';
  return 'ignore';
}

interface CollaborationSessionHeartbeatTask {
  generation: number;
  controller: AbortController;
  promise: Promise<void>;
}

export class CollaborationSessionHeartbeatSingleFlight {
  private active: CollaborationSessionHeartbeatTask | null = null;

  async run(generation: number, task: (signal: AbortSignal) => Promise<void>) {
    while (this.active) {
      const previous = this.active;
      if (previous.generation === generation) return previous.promise;
      previous.controller.abort();
      try { await previous.promise; } catch { /* the owning generation handles its failure */ }
    }

    const controller = new AbortController();
    const active: CollaborationSessionHeartbeatTask = {
      generation,
      controller,
      promise: Promise.resolve(),
    };
    this.active = active;
    active.promise = Promise.resolve()
      .then(() => task(controller.signal))
      .finally(() => {
        if (this.active === active) this.active = null;
      });
    return active.promise;
  }

  cancel(generation?: number) {
    if (!this.active || (generation != null && this.active.generation !== generation)) return false;
    this.active.controller.abort();
    return true;
  }
}

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const numeric = value;
  return Math.min(maximum, Math.max(minimum, Math.trunc(numeric)));
}

export function normalizeCollaborationProtocol(value: unknown): CollaborationProtocolSettings {
  const source = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const heartbeatIntervalMs = boundedInteger(
    source.heartbeatIntervalMs,
    COLLABORATION_HEARTBEAT_INTERVAL_MS,
    1_000,
    120_000,
  );
  return {
    version: boundedInteger(source.version, 0, 0, 100),
    heartbeatIntervalMs,
    heartbeatTimeoutMs: boundedInteger(
      source.heartbeatTimeoutMs,
      COLLABORATION_HEARTBEAT_TIMEOUT_MS,
      heartbeatIntervalMs * 2,
      300_000,
    ),
    maxSyncOperations: boundedInteger(source.maxSyncOperations, 500, 1, 500),
  };
}

export function collaborationReconnectDelay(
  attempt: number,
  random: () => number = Math.random,
) {
  const normalizedAttempt = Math.max(0, Math.trunc(Number(attempt) || 0));
  const exponential = Math.min(
    COLLABORATION_RECONNECT_MAX_MS,
    COLLABORATION_RECONNECT_BASE_MS * (2 ** Math.min(normalizedAttempt, 20)),
  );
  const randomValue = Math.min(1, Math.max(0, Number(random()) || 0));
  const multiplier = 1 - COLLABORATION_RECONNECT_JITTER
    + randomValue * COLLABORATION_RECONNECT_JITTER * 2;
  return Math.max(
    100,
    Math.min(COLLABORATION_RECONNECT_MAX_MS, Math.round(exponential * multiplier)),
  );
}

export function collaborationHeartbeatExpired(
  lastPongAt: number,
  now: number,
  timeoutMs: number,
) {
  if (![lastPongAt, now, timeoutMs].every((value) => Number.isFinite(value))
    || now < lastPongAt
    || timeoutMs < 0) return true;
  return now - lastPongAt >= Math.max(1, timeoutMs);
}

export function classifyCollaborationClose(
  code: number,
  reason = '',
  notice: CollaborationGatewayNotice | null = null,
): CollaborationCloseDecision {
  const normalizedReason = String(notice?.reason || reason || '').toLowerCase();
  if (code === 4001) {
    return {
      action: 'stop',
      phase: 'revoked',
      message: '主机已撤销当前协作会话，请重新获取邀请链接。',
    };
  }
  if (code === 4002) {
    return {
      action: 'refresh-session',
      phase: 'reconnecting',
      message: '协作权限已变化，正在刷新会话后重新连接。',
      retryAfterMs: 0,
    };
  }
  if (code === 4003) {
    return {
      action: 'stop',
      phase: 'blocked',
      message: '主机画布的资源授权范围不可用，请联系主机重新确认共享范围。',
    };
  }
  if (code === 1008) {
    return {
      action: 'stop',
      phase: 'blocked',
      message: '协作连接因安全策略被拒绝，请联系主机检查会话和访问范围。',
    };
  }
  if (code === 4004 || normalizedReason === 'host_stopped' || normalizedReason.includes('gateway stopped')) {
    return {
      action: notice?.retryable === true ? 'retry' : 'stop',
      phase: notice?.retryable === true ? 'reconnecting' : 'host-stopped',
      message: '主机已停止协作网关，未提交的画布操作仍保留在本机。',
      retryAfterMs: boundedInteger(notice?.retryAfterMs, 0, 0, 300_000),
    };
  }
  if (normalizedReason === 'message_rate_limited'
    || normalizedReason.includes('message rate exceeded')) {
    return {
      action: 'retry',
      phase: 'reconnecting',
      message: '协作消息暂时过于频繁，未提交操作仍保留，正在按服务端限额等待重连。',
      retryAfterMs: boundedInteger(notice?.retryAfterMs, 1_000, 1_000, 300_000),
    };
  }
  if (code === 1013 || normalizedReason.includes('session refresh temporarily unavailable')) {
    return {
      action: 'retry',
      phase: 'reconnecting',
      message: '主机暂时无法刷新协作会话，未提交操作仍保留，正在等待重新连接。',
      retryAfterMs: boundedInteger(notice?.retryAfterMs, 1_000, 0, 300_000),
    };
  }
  if (code === 1012 || normalizedReason === 'gateway_restarted' || normalizedReason.includes('gateway restarted')) {
    return {
      action: 'retry',
      phase: 'reconnecting',
      message: '主机正在重启协作网关；若主机更改了地址，请使用新的协作链接。',
      retryAfterMs: boundedInteger(notice?.retryAfterMs, 500, 0, 300_000),
    };
  }
  if (code === 1000) {
    return {
      action: 'stop',
      phase: 'offline',
      message: '协作连接已正常关闭。',
    };
  }
  return {
    action: 'retry',
    phase: 'reconnecting',
    message: '协作连接已中断，未提交操作仍保留，正在等待重新连接。',
  };
}
