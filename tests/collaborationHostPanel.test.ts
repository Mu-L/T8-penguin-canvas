import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (relativePath: string) => readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');
const panel = read('src/components/CollaborationHostPanel.tsx');
const workbench = read('src/components/ProjectWorkbench.tsx');
const api = read('src/services/api.ts');
const types = read('src/types/project.ts');
const managementRoute = read('backend/src/routes/collaboration.js');

test('Project Workbench delegates the collaboration tab to the scoped host panel', () => {
  assert.match(workbench, /import CollaborationHostPanel from '\.\/CollaborationHostPanel'/);
  assert.match(workbench, /<CollaborationHostPanel\s+projectId=\{props\.projectId\}\s+canvasId=\{props\.canvasId\}\s+onAcceptRunIntent=\{props\.onAcceptRunIntent\}/);
  assert.doesNotMatch(workbench, /t8-collaboration-public-base-url/);
  assert.doesNotMatch(workbench, /const \[collaboration, setCollaboration\]/);
});

test('host status is canvas-room-scoped and room connection count wins over the global gateway count', () => {
  assert.match(panel, /api\.getCollaborationStatus\(projectId, canvasId, \{ signal: controller\.signal \}\)/);
  assert.match(api, /export async function getCollaborationStatus\(\s+projectId\?: string,/);
  assert.match(api, /if \(projectId\) params\.set\('projectId', projectId\)/);
  assert.match(api, /if \(canvasId\) params\.set\('canvasId', canvasId\)/);
  assert.match(api, /`\$\{BASE\}\/collaboration\/status\$\{suffix\}`/);
  assert.match(panel, /const roomConnectionCount = status\.room\?\.connectionCount \?\? status\.connectionCount/);
  assert.match(types, /export interface CollaborationRoomStatus \{[\s\S]*projectId: string;[\s\S]*canvasId: string;[\s\S]*connectionCount: number;/);
});

test('gateway settings use enumerated interfaces, actual share URLs, validation, and two-step stop confirmation', () => {
  assert.match(panel, /status\.networkInterfaces\.map\(\(entry\) => <option/);
  assert.match(panel, /entry\.address/);
  assert.match(panel, /return nextStatus\.host \|\| nextStatus\.defaultHost \|\| '127\.0\.0\.1'/);
  assert.doesNotMatch(panel, /nextStatus\.networkInterfaces\[0\]\?\.address/);
  assert.match(panel, /nextStatus\.shareUrls\.length === 1\s+\? nextStatus\.shareUrls\[0\]\s+: ''/);
  assert.match(panel, /status\.shareUrls\.length > 1 && <option value="" disabled>请选择实际共享地址/);
  assert.match(panel, /status\.shareUrls\.map\(\(url\) => <option/);
  assert.match(panel, /selectedHost === '0\.0\.0\.0'/);
  assert.match(panel, /协作端口必须是 1024-65535 的整数/);
  assert.match(panel, /if \(!stopConfirm\) \{/);
  assert.match(panel, /再次确认停止/);
  assert.match(panel, /api\.stopCollaborationGateway/);
  assert.match(panel, /监听端口已经关闭/);
});

test('F9 public Base URL self-check is local-management-only and keeps HTTP public risk visible', () => {
  assert.match(panel, /data-testid="collaboration-public-self-check"/);
  assert.match(panel, /api\.runCollaborationPublicSelfCheck\(baseUrl\)/);
  assert.match(panel, /health、邀请兑换、WebSocket Upgrade、微型上传与 Range/);
  assert.match(panel, /短时单次内存探针，不创建长期邀请、素材或项目数据/);
  assert.match(panel, /data-testid="collaboration-public-http-warning"/);
  assert.match(panel, /data-testid="collaboration-public-exposure-configuration-warning"/);
  assert.match(panel, /publicExposureConfiguration\?\.canClearPersisted/);
  assert.match(panel, /api\.clearCollaborationPublicBaseUrl/);
  assert.match(panel, /服务端将禁止 owner 管理能力和敏感原件下载/);
  assert.match(panel, /局域网与本机开发地址不受此降级影响/);
  assert.match(panel, /不会自动开放 Windows 防火墙、启用 UPnP 或保存路由器账号/);
  assert.match(panel, /PUBLIC_SELF_CHECK_LABELS/);
  assert.match(api, /export async function runCollaborationPublicSelfCheck\(/);
  assert.match(api, /collaboration\/public-self-check/);
  assert.match(api, /normalizeCollaborationPublicSelfCheck\(res\.data\)/);
  assert.match(api, /export async function clearCollaborationPublicBaseUrl\(\)/);
  assert.match(api, /method: 'DELETE'/);
  assert.match(types, /export interface CollaborationPublicSelfCheck \{[\s\S]*status: 'passed' \| 'degraded' \| 'failed';[\s\S]*checks: CollaborationPublicSelfCheckResult\[\];/);
  assert.match(types, /export interface CollaborationPublicExposureConfiguration \{[\s\S]*status: 'configured' \| 'unconfigured' \| 'invalid';[\s\S]*failClosed: boolean;/);
  assert.match(managementRoute, /router\.post\('\/public-self-check'/);
  assert.match(managementRoute, /router\.delete\('\/public-base-url'/);
  assert.match(managementRoute, /normalizePublicSelfCheckInput\(req\.body\)/);
  assert.match(
    managementRoute,
    /router\.use\(loopbackOnly\);\s+router\.use\(trustedManagementRequest\);\s+router\.use\(managementAuthorityRequest\(managementAuthority\)\);/,
  );
});

test('invite creation binds project and canvas, supports role expiry and max uses, and generates QR locally', () => {
  assert.match(panel, /api\.createCollaborationInvite\(\{\s+projectId,\s+canvasId,\s+role: inviteRole,\s+expiresInMs: inviteExpiryMs,\s+maxUses: inviteMaxUses,/);
  assert.match(panel, /EXPIRY_OPTIONS/);
  assert.match(panel, /最大使用次数/);
  assert.match(panel, /max=\{100\}/);
  assert.match(panel, /Math\.min\(100, Number\(event\.target\.value\)/);
  assert.match(panel, /import QRCode from 'qrcode'/);
  assert.match(panel, /QRCode\.toDataURL\(latestInviteUrl/);
  assert.match(panel, /二维码在本机生成，不上传到第三方服务/);
  assert.doesNotMatch(panel, /api\.qrserver|chart\.googleapis|quickchart\.io/i);
  assert.match(api, /createCollaborationInvite\(input: \{\s+projectId: string;\s+canvasId: string;/);
});

test('legacy canvases require an explicit two-step resource-scope confirmation before invitations', () => {
  assert.match(types, /export interface CollaborationResourceScopeStatus \{[\s\S]*status: 'ready' \| 'confirmation-required' \| 'stale';[\s\S]*assetCount: number;[\s\S]*subflowCount: number;/);
  assert.match(panel, /const resourceScopeReady = resourceScope\?\.ready \?\? true/);
  assert.match(panel, /if \(!resourceScopeConfirm\) \{/);
  assert.match(panel, /再次点击将把当前画布引用的素材和固定子工作流版本设为本房间可访问资源/);
  assert.match(panel, /api\.initializeCollaborationResourceScope\(projectId, canvasId\)/);
  assert.match(panel, /disabled=\{!status\.running \|\| !canvasId \|\| !shareBaseUrl \|\| !resourceScopeReady \|\| Boolean\(mutation\)\}/);
  assert.match(api, /export async function initializeCollaborationResourceScope\(/);
  assert.match(api, /collaboration\/resource-scope\/initialize/);
  assert.match(api, /confirmed: true/);
});

test('invite, member, and session management stay inside the current canvas room and expose immediate disconnect actions', () => {
  for (const binding of [
    'listCollaborationInvites',
    'revokeCollaborationInvite',
    'listCollaborationMembers',
    'updateCollaborationMember',
    'removeCollaborationMember',
    'listCollaborationSessions',
    'revokeCollaborationSession',
    'revokeAllCollaborationSessions',
  ]) {
    assert.match(api, new RegExp(`export async function ${binding}`));
    assert.match(panel, new RegExp(`api\\.${binding}`));
  }
  assert.match(api, /body: JSON\.stringify\(\{ \.\.\.patch, projectId, canvasId \}\)/);
  assert.match(api, /body: JSON\.stringify\(\{ projectId, canvasId \}\)/);
  assert.match(panel, /修改角色会刷新在线连接，原会话和成员身份保持不变/);
  assert.match(panel, /撤销后立即关闭匹配的 WebSocket 连接/);
  assert.match(panel, /撤销当前画布房间的全部会话/);
  assert.match(panel, /再次确认全部断开/);
  assert.match(panel, /disconnectedConnections/);
});

test('the host panel advances or cancels queue intents only with the current queue revision', () => {
  assert.match(panel, /api\.listCollaborationRunIntents\('actionable', projectId, canvasId/);
  assert.match(panel, /nextRunIntents\.filter\(\(intent\) => !canvasId \|\| intent\.canvasId === canvasId\)/);
  assert.match(panel, /Number\.isSafeInteger\(intent\.queueRevision\)/);
  assert.match(panel, /api\.acceptCollaborationRunIntent\(intent\.id, projectId, canvasId, \{\s+expectedQueueRevision: Number\(intent\.queueRevision\),/);
  assert.match(panel, /api\.cancelCollaborationRunIntent\(intent\.id, projectId, canvasId, \{\s+expectedQueueRevision: Number\(intent\.queueRevision\),/);
  assert.match(panel, /onAcceptRunIntent\(accepted\)/);
  assert.match(panel, /intent\.status === 'accepted' && intent\.confirmationRequired !== false/);
  assert.match(panel, /onAcceptRunIntent\(intent\)/);
  assert.match(panel, /执行已确认请求/);
  assert.match(panel, /执行器随后以一次性租约领取/);
});

test('host execution policy exposes an explicit complete local configuration without ambiguous unlimited defaults', () => {
  assert.match(panel, /data-testid="collaboration-execution-policy-management"/);
  assert.match(panel, /api\.getCollaborationExecutionPolicy\(projectId, \{ signal: controller\.signal \}\)/);
  assert.match(panel, /api\.updateCollaborationExecutionPolicy\(projectId, \{\s+allowedModels,\s+dailyCostLimit,\s+perRunCostLimit,\s+concurrencyLimit,/);
  assert.match(panel, /\* 表示模型不限/);
  assert.match(panel, /每日额度与单次成本的 <strong>0 表示不限<\/strong>/);
  assert.match(panel, /空白模型列表表示禁止所有模型/);
  assert.match(panel, /并发始终有限，范围为 1-64，默认 2/);
  assert.match(panel, /今日已计成本/);
  assert.match(panel, /活动意图/);
  assert.match(api, /export async function updateCollaborationExecutionPolicy\(/);
  assert.match(api, /method: 'PUT'/);
  assert.match(api, /body: JSON\.stringify\(\{ projectId, \.\.\.input \}\)/);
  assert.match(types, /export interface CollaborationExecutionPolicyInput \{[\s\S]*allowedModels: string\[\];[\s\S]*dailyCostLimit: number;[\s\S]*perRunCostLimit: number;[\s\S]*concurrencyLimit: number;/);
  assert.match(managementRoute, /normalizeExecutionPolicyInput\(req\.body\)/);
  assert.match(managementRoute, /执行策略必须一次提交完整配置/);
});

test('host audit viewer is local-only, window-bounded, filtered, paginated, and receives redacted session references', () => {
  assert.match(panel, /data-testid="collaboration-audit-events"/);
  assert.match(panel, /api\.listCollaborationAuditEvents\(\{/);
  assert.match(panel, /动作（精确）/);
  assert.match(panel, /操作者 ID（精确）/);
  assert.match(panel, /目标类型（精确）/);
  assert.match(panel, /最近 \{auditPage\.pagination\.windowLimit\} 条事件窗口/);
  assert.match(panel, /session \{event\.sessionRef \|\| '—'\}/);
  assert.match(panel, /auditPage\.pagination\.nextOffset/);
  assert.match(api, /export async function listCollaborationAuditEvents\(/);
  assert.match(api, /collaboration\/audit-events/);
  assert.match(types, /export interface CollaborationAuditEvent \{[\s\S]*sessionRef\?: string \| null;[\s\S]*metadata: Record<string, unknown> \| unknown\[\];/);
  assert.doesNotMatch(types.match(/export interface CollaborationAuditEvent \{[\s\S]*?\n\}/)?.[0] || '', /sessionId/);
  assert.match(managementRoute, /router\.get\('\/audit-events'/);
  assert.match(managementRoute, /AUDIT_QUERY_WINDOW_LIMIT = 1000/);
  assert.match(managementRoute, /sessionRef: auditReferenceDigest\(sessionId\)/);
  assert.match(managementRoute, /\/session\/i\.test\(targetType \|\| ''\)[\s\S]*opaqueAuditReference\(event\.targetId, 'session'\)/);
  assert.match(managementRoute, /metadata: boundedAuditMetadata\(event\.metadata\)/);
  assert.match(
    managementRoute,
    /router\.use\(loopbackOnly\);\s+router\.use\(trustedManagementRequest\);\s+router\.use\(managementAuthorityRequest\(managementAuthority\)\);/,
  );
  assert.match(managementRoute, /crypto\.timingSafeEqual\(receivedDigest, authority\.tokenDigest\)/);
  assert.match(managementRoute, /createdBy: req\.managementPrincipal\.actorId/);
  assert.match(managementRoute, /sessionId: req\.managementPrincipal\.sessionId/);
});
