import assert from 'node:assert/strict';
import test from 'node:test';

import {
  COLLABORATION_HEARTBEAT_INTERVAL_MS,
  COLLABORATION_HEARTBEAT_TIMEOUT_MS,
  COLLABORATION_SESSION_HEARTBEAT_INTERVAL_MS,
  CollaborationSessionHeartbeatSingleFlight,
  classifyCollaborationClose,
  classifyCollaborationSessionHeartbeatFailure,
  collaborationHeartbeatExpired,
  collaborationReconnectDelay,
  collaborationSessionHeartbeatIdentity,
  normalizeCollaborationProtocol,
  sameCollaborationSessionHeartbeatIdentity,
} from '../src/utils/collaborationConnection.ts';

test('durable session heartbeat uses a separate one-minute cadence and an exact five-field identity', () => {
  assert.equal(COLLABORATION_SESSION_HEARTBEAT_INTERVAL_MS, 60_000);
  const identity = collaborationSessionHeartbeatIdentity({
    id: 'session-heartbeat-1',
    projectId: 'project-heartbeat-1',
    canvasId: 'canvas-heartbeat-1',
    memberId: 'member-heartbeat-1',
    authorizationEpoch: 7,
    capabilities: ['editGraph'],
    token: 'must-not-be-copied',
  });
  assert.deepEqual(identity, {
    sessionId: 'session-heartbeat-1',
    projectId: 'project-heartbeat-1',
    canvasId: 'canvas-heartbeat-1',
    memberId: 'member-heartbeat-1',
    authorizationEpoch: 7,
  });
  assert.deepEqual(Object.keys(identity || {}), [
    'sessionId',
    'projectId',
    'canvasId',
    'memberId',
    'authorizationEpoch',
  ]);
});

test('durable session heartbeat identity fails closed for missing, malformed, or ambiguous values', () => {
  const valid = {
    id: 'session-heartbeat-2',
    projectId: 'project-heartbeat-2',
    canvasId: 'canvas-heartbeat-2',
    memberId: 'member-heartbeat-2',
    authorizationEpoch: 9,
  };
  for (const malformed of [
    null,
    [],
    { ...valid, id: '' },
    { ...valid, id: ' session-heartbeat-2' },
    { ...valid, projectId: 'project\nheartbeat' },
    { ...valid, canvasId: 'x'.repeat(241) },
    { ...valid, memberId: 12 },
    { ...valid, authorizationEpoch: 0 },
    { ...valid, authorizationEpoch: 1.5 },
    { ...valid, authorizationEpoch: '9' },
  ]) {
    assert.equal(collaborationSessionHeartbeatIdentity(malformed), null);
  }
});

test('durable session heartbeat compares every identity field and classifies only terminal auth statuses', () => {
  const identity = collaborationSessionHeartbeatIdentity({
    id: 'session-heartbeat-3',
    projectId: 'project-heartbeat-3',
    canvasId: 'canvas-heartbeat-3',
    memberId: 'member-heartbeat-3',
    authorizationEpoch: 11,
  });
  assert.equal(sameCollaborationSessionHeartbeatIdentity(identity, { ...identity! }), true);
  assert.equal(sameCollaborationSessionHeartbeatIdentity(identity, { ...identity!, authorizationEpoch: 12 }), false);
  assert.equal(sameCollaborationSessionHeartbeatIdentity(identity, null), false);

  assert.equal(classifyCollaborationSessionHeartbeatFailure(401), 'revoke');
  assert.equal(classifyCollaborationSessionHeartbeatFailure({ status: 403 }), 'block');
  assert.equal(classifyCollaborationSessionHeartbeatFailure({ status: 409 }), 'refresh-session');
  for (const value of [429, 500, 503, 507, 0, null, new Error('network')]) {
    assert.equal(classifyCollaborationSessionHeartbeatFailure(value), 'ignore');
  }
});

test('durable session heartbeat single-flight aborts and fully settles an old generation before starting the next', async () => {
  const coordinator = new CollaborationSessionHeartbeatSingleFlight();
  const starts: number[] = [];
  let firstSignal: AbortSignal | null = null;
  let settleFirst = () => undefined;
  const first = coordinator.run(1, async (signal) => {
    starts.push(1);
    firstSignal = signal;
    await new Promise<void>((resolve) => { settleFirst = resolve; });
  });
  await Promise.resolve();
  assert.deepEqual(starts, [1]);

  const second = coordinator.run(2, async () => {
    starts.push(2);
  });
  await Promise.resolve();
  assert.equal(firstSignal?.aborted, true);
  assert.deepEqual(starts, [1], 'new generation must wait for the aborted task to settle');
  settleFirst();
  await Promise.all([first, second]);
  assert.deepEqual(starts, [1, 2]);

  let settleThird = () => undefined;
  const third = coordinator.run(3, async () => {
    starts.push(3);
    await new Promise<void>((resolve) => { settleThird = resolve; });
  });
  const duplicate = coordinator.run(3, async () => {
    starts.push(300);
  });
  await Promise.resolve();
  assert.deepEqual(starts, [1, 2, 3]);
  assert.equal(coordinator.cancel(4), false);
  assert.equal(coordinator.cancel(3), true);
  settleThird();
  await Promise.all([third, duplicate]);
  assert.deepEqual(starts, [1, 2, 3]);

  let settleFourth = () => undefined;
  const fourth = coordinator.run(4, async () => {
    starts.push(4);
    await new Promise<void>((resolve) => { settleFourth = resolve; });
  });
  await Promise.resolve();
  let currentGeneration = true;
  let staleSideEffects = 0;
  const fifth = coordinator.run(5, async (signal) => {
    if (signal.aborted || !currentGeneration) return;
    staleSideEffects += 1;
  });
  await Promise.resolve();
  currentGeneration = false;
  assert.equal(coordinator.cancel(5), false);
  settleFourth();
  await Promise.all([fourth, fifth]);
  assert.equal(staleSideEffects, 0, 'a disposed generation must not start a durable request after waiting');
});

test('collaboration protocol defaults and bounds every negotiated value', () => {
  assert.deepEqual(normalizeCollaborationProtocol(null), {
    version: 0,
    heartbeatIntervalMs: COLLABORATION_HEARTBEAT_INTERVAL_MS,
    heartbeatTimeoutMs: COLLABORATION_HEARTBEAT_TIMEOUT_MS,
    maxSyncOperations: 500,
  });
  assert.deepEqual(normalizeCollaborationProtocol([]), normalizeCollaborationProtocol(null));
  assert.deepEqual(normalizeCollaborationProtocol({
    version: 200,
    heartbeatIntervalMs: 999,
    heartbeatTimeoutMs: 1,
    maxSyncOperations: 0,
  }), {
    version: 100,
    heartbeatIntervalMs: 1_000,
    heartbeatTimeoutMs: 2_000,
    maxSyncOperations: 1,
  });
  assert.deepEqual(normalizeCollaborationProtocol({
    version: 2.9,
    heartbeatIntervalMs: 120_001,
    heartbeatTimeoutMs: 999_999,
    maxSyncOperations: 501,
  }), {
    version: 2,
    heartbeatIntervalMs: 120_000,
    heartbeatTimeoutMs: 300_000,
    maxSyncOperations: 500,
  });
});

test('collaboration protocol does not coerce malformed scalar types into negotiated settings', () => {
  assert.deepEqual(normalizeCollaborationProtocol({
    version: '2',
    heartbeatIntervalMs: '1000',
    heartbeatTimeoutMs: '2000',
    maxSyncOperations: '5',
  }), normalizeCollaborationProtocol(null));
  assert.deepEqual(normalizeCollaborationProtocol({
    version: true,
    heartbeatIntervalMs: false,
    heartbeatTimeoutMs: true,
    maxSyncOperations: false,
  }), normalizeCollaborationProtocol(null));
});

test('reconnect delay uses deterministic exponential backoff, jitter, and a hard cap', () => {
  assert.equal(collaborationReconnectDelay(0, () => 0), 400);
  assert.equal(collaborationReconnectDelay(0, () => 0.5), 500);
  assert.equal(collaborationReconnectDelay(0, () => 1), 600);
  assert.equal(collaborationReconnectDelay(1, () => 0), 800);
  assert.equal(collaborationReconnectDelay(1, () => 0.5), 1_000);
  assert.equal(collaborationReconnectDelay(1, () => 1), 1_200);
  assert.equal(collaborationReconnectDelay(-10, () => 0.5), 500);
  assert.equal(collaborationReconnectDelay(20, () => 0), 12_000);
  assert.equal(collaborationReconnectDelay(20, () => 0.5), 15_000);
  assert.equal(collaborationReconnectDelay(20, () => 1), 15_000);
  assert.equal(collaborationReconnectDelay(Number.POSITIVE_INFINITY, () => 0.5), 15_000);
  assert.equal(collaborationReconnectDelay(0, () => Number.NaN), 400);
  assert.equal(collaborationReconnectDelay(0, () => -10), 400);
  assert.equal(collaborationReconnectDelay(0, () => 10), 600);
});

test('heartbeat expiry is exact at the timeout boundary', () => {
  assert.equal(collaborationHeartbeatExpired(100, 159, 60), false);
  assert.equal(collaborationHeartbeatExpired(100, 160, 60), true);
  assert.equal(collaborationHeartbeatExpired(100, 161, 60), true);
  assert.equal(collaborationHeartbeatExpired(100, 100, 0), false);
  assert.equal(collaborationHeartbeatExpired(100, 101, 0), true);
});

test('heartbeat expiry fails closed for invalid or regressing clocks', () => {
  assert.deepEqual([
    collaborationHeartbeatExpired(Number.NaN, 200, 60),
    collaborationHeartbeatExpired(100, Number.NaN, 60),
    collaborationHeartbeatExpired(100, 100, Number.NaN),
    collaborationHeartbeatExpired(200, 100, 60),
  ], [true, true, true, true]);
});

test('security and lifecycle close codes cannot be downgraded by a retryable notice', () => {
  const retryable = { reason: 'gateway_restarted', retryable: true, retryAfterMs: 10 };
  assert.deepEqual(classifyCollaborationClose(4001, '', retryable), {
    action: 'stop',
    phase: 'revoked',
    message: '主机已撤销当前协作会话，请重新获取邀请链接。',
  });
  assert.deepEqual(classifyCollaborationClose(4002, '', retryable), {
    action: 'refresh-session',
    phase: 'reconnecting',
    message: '协作权限已变化，正在刷新会话后重新连接。',
    retryAfterMs: 0,
  });
  assert.deepEqual(classifyCollaborationClose(4003, '', retryable), {
    action: 'stop',
    phase: 'blocked',
    message: '主机画布的资源授权范围不可用，请联系主机重新确认共享范围。',
  });
  assert.deepEqual(classifyCollaborationClose(1008, '', retryable), {
    action: 'stop',
    phase: 'blocked',
    message: '协作连接因安全策略被拒绝，请联系主机检查会话和访问范围。',
  });
});

test('host stop, restart, normal close, and abnormal close have distinct retry policies', () => {
  assert.deepEqual(classifyCollaborationClose(4004), {
    action: 'stop',
    phase: 'host-stopped',
    message: '主机已停止协作网关，未提交的画布操作仍保留在本机。',
    retryAfterMs: 0,
  });
  assert.deepEqual(classifyCollaborationClose(4004, '', {
    reason: 'host_stopped',
    retryable: true,
    retryAfterMs: 999_999,
  }), {
    action: 'retry',
    phase: 'reconnecting',
    message: '主机已停止协作网关，未提交的画布操作仍保留在本机。',
    retryAfterMs: 300_000,
  });
  assert.equal(classifyCollaborationClose(1006, 'gateway stopped').phase, 'host-stopped');
  assert.deepEqual(classifyCollaborationClose(1012), {
    action: 'retry',
    phase: 'reconnecting',
    message: '主机正在重启协作网关；若主机更改了地址，请使用新的协作链接。',
    retryAfterMs: 500,
  });
  assert.deepEqual(classifyCollaborationClose(1013, 'session refresh temporarily unavailable'), {
    action: 'retry',
    phase: 'reconnecting',
    message: '主机暂时无法刷新协作会话，未提交操作仍保留，正在等待重新连接。',
    retryAfterMs: 1_000,
  });
  assert.equal(classifyCollaborationClose(1006, 'gateway restarted').action, 'retry');
  assert.equal(classifyCollaborationClose(1000).action, 'stop');
  assert.equal(classifyCollaborationClose(1000).phase, 'offline');
  assert.equal(classifyCollaborationClose(1006).action, 'retry');
  assert.equal(classifyCollaborationClose(1006).phase, 'reconnecting');
});

test('message-rate close honors the server retry window without becoming a terminal security block', () => {
  assert.deepEqual(classifyCollaborationClose(1013, 'message rate exceeded', {
    reason: 'message_rate_limited',
    retryable: true,
    retryAfterMs: 12_345,
  }), {
    action: 'retry',
    phase: 'reconnecting',
    message: '协作消息暂时过于频繁，未提交操作仍保留，正在按服务端限额等待重连。',
    retryAfterMs: 12_345,
  });
  assert.equal(
    classifyCollaborationClose(1013, 'message rate exceeded', {
      reason: 'message_rate_limited',
      retryable: true,
      retryAfterMs: 0,
    }).retryAfterMs,
    1_000,
  );
});
