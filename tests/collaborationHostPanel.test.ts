import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (relativePath: string) => readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');
const panel = read('src/components/CollaborationHostPanel.tsx');
const workbench = read('src/components/ProjectWorkbench.tsx');
const api = read('src/services/api.ts');
const types = read('src/types/project.ts');

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

test('the new panel preserves host-authoritative run intent accept and reject controls', () => {
  assert.match(panel, /api\.listCollaborationRunIntents\('actionable', projectId, canvasId/);
  assert.match(panel, /nextRunIntents\.filter\(\(intent\) => !canvasId \|\| intent\.canvasId === canvasId\)/);
  assert.match(panel, /onAcceptRunIntent\(intent\)/);
  assert.match(panel, /api\.updateCollaborationRunIntent\(intent\.id, projectId, canvasId \|\| '', \{ status: 'rejected' \}\)/);
  assert.match(panel, /远端只能提交意图；Provider 调用仍由本机主机确认并执行/);
});
