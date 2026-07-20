import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (relativePath: string) => readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8').replace(/\r\n?/g, '\n');
const panel = read('src/components/CollaborationReviewPanel.tsx');
const workspace = read('src/components/CollaborationWorkspace.tsx');
const hostPanel = read('src/components/CollaborationHostPanel.tsx');
const api = read('src/services/api.ts');
const types = read('src/types/project.ts');
const gateway = read('backend/src/collaboration/gateway.js');

function section(source: string, start: string, end: string) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(from, -1, `missing section start: ${start}`);
  assert.notEqual(to, -1, `missing section end: ${end}`);
  return source.slice(from, to);
}

test('F6 review writes carry exact canvas and thread CAS instead of accepting server-side latest defaults', () => {
  const create = section(panel, 'const submitThread = async () => {', 'const submitReply = async');
  assert.match(create, /const expectedCanvasRevision = canvasRevision;/);
  assert.match(create, /'\/api\/collab\/reviews'/);
  assert.match(create, /expectedCanvasRevision,/);
  assert.match(create, /anchor,/);
  assert.match(create, /mentions: uniqueLimited\(references\.mentions\)/);
  assert.match(create, /attachments,/);

  const reply = section(panel, 'const submitReply = async', 'const updateThread = async');
  assert.match(reply, /const expectedCanvasRevision = canvasRevision;/);
  assert.match(reply, /const expectedThreadRevision = thread\.revision;/);
  assert.match(reply, /\/api\/collab\/reviews\/\$\{encodeURIComponent\(thread\.id\)\}\/comments/);
  assert.match(reply, /expectedCanvasRevision,/);
  assert.match(reply, /expectedThreadRevision,/);
  assert.match(reply, /\.\.\.\(draft\.parentId \? \{ parentId: draft\.parentId \} : \{\}\)/);

  const update = section(panel, 'const updateThread = async', 'const markNotificationRead = async');
  assert.match(update, /const expectedCanvasRevision = canvasRevision;/);
  assert.match(update, /const expectedThreadRevision = thread\.revision;/);
  assert.match(update, /method: 'PATCH'/);
  assert.match(update, /expectedCanvasRevision,/);
  assert.match(update, /expectedThreadRevision,/);
  assert.doesNotMatch(`${create}\n${reply}\n${update}`, /expected(?:Canvas|Thread)?Revision\s*\?\?/);
});

test('F6 composer covers every anchor kind and pins video plus attachments to immutable content evidence', () => {
  assert.match(types, /CollaborationReviewAnchorKind = 'canvas' \| 'node' \| 'edge' \| 'asset' \| 'video'/);
  assert.match(types, /kind: 'video';[\s\S]*frameMs: number;[\s\S]*assetContentRevision: number;[\s\S]*contentHash: string;/);
  assert.match(types, /interface CollaborationReviewAttachment[\s\S]*assetContentRevision\?: number;[\s\S]*contentHash\?: string;/);
  assert.match(panel, /<option value="canvas">画布坐标<\/option><option value="node">节点<\/option><option value="edge">连线<\/option><option value="asset">素材<\/option><option value="video">视频帧<\/option>/);
  assert.match(panel, /时间码 \/ 帧位置（毫秒）/);
  assert.match(panel, /assetContentRevision: pinnedRevision,/);
  assert.match(panel, /contentHash: pinnedHash,/);
  assert.match(panel, /reviewReferenceInputs\(references\.assetUids, assets\)/);
  assert.match(panel, /uniqueLimited\(values[\s\S]*\.slice\(0, limit\)/);
  assert.match(panel, /@成员 \(\{value\.mentions\.length\}\/20\)/);
  assert.match(panel, /授权附件 \(\{value\.assetUids\.length\}\/20\)/);
});

test('F6 threads support nested replies, author-only F4 editing, lifecycle actions and expiry evidence', () => {
  assert.match(panel, /childrenByParent\.get\(comment\.id\)/);
  assert.match(panel, /renderComment\(child, depth \+ 1, nextPath\)/);
  assert.match(panel, /parentId: draft\.parentId/);
  assert.match(panel, /safeMemberId\(comment\.createdBy\) === safeMemberId\(memberId\)/);
  assert.match(panel, /authorOnly && comment\.entityUid/);
  assert.match(workspace, /String\(item\.createdBy \|\| ''\)\.toLowerCase\(\)[\s\S]*!== String\(sessionRef\.current\?\.memberId \|\| ''\)\.toLowerCase\(\)/);
  assert.match(panel, /解决线程/);
  assert.match(panel, /重新打开线程/);
  assert.match(panel, />提交审片<\/button>/);
  assert.match(panel, />重新提交审片<\/button>/);
  assert.match(panel, />批准<\/button>/);
  assert.match(panel, />请求修改<\/button>/);
  assert.match(panel, /重新批准当前版本/);
  assert.doesNotMatch(panel, />撤销决定并重开<\/button>/);
  assert.match(panel, /data-testid="collaboration-review-approval-expired"/);
  assert.match(panel, /决定绑定 r\{selectedThread\.decisionCanvasRevision \?\? '\?'\}，当前画布 r/);
  assert.match(types, /effectiveStatus: CollaborationReviewEffectiveStatus;/);
  assert.match(types, /resolutionStatus: CollaborationReviewResolutionStatus;/);
  assert.match(types, /reviewStatus: CollaborationReviewLifecycleStatus;/);
  assert.match(types, /effectiveReviewStatus: CollaborationReviewEffectiveLifecycleStatus;/);
  assert.match(types, /approvalExpired: boolean;/);
});

test('F6 review discovery includes bounded filters, navigation, export, notifications and safe comparison', () => {
  for (const queryField of ['reviewStatus', 'severity', 'anchorKind', 'createdBy', 'unresolved', 'approvalExpired']) {
    assert.match(panel, new RegExp(`query\\.set\\('${queryField}'`));
  }
  assert.match(panel, /title="上一条"/);
  assert.match(panel, /title="下一条"/);
  assert.match(panel, /selectThreadAt\(selectedIndex - 1\)/);
  assert.match(panel, /selectThreadAt\(selectedIndex \+ 1\)/);
  assert.match(panel, /\/api\/collab\/reviews\/export\?\$\{query\}/);
  assert.match(panel, /exportReviews\('json'\)/);
  assert.match(panel, /exportReviews\('markdown'\)/);
  assert.match(panel, /\/api\/collab\/notifications\?canvasId=/);
  assert.match(panel, /\/api\/collab\/notifications\/\$\{encodeURIComponent\(notification\.id\)\}\/read/);
  assert.match(panel, /method: 'PATCH'/);
  assert.match(panel, /\/api\/collab\/reviews\/\$\{encodeURIComponent\(thread\.id\)\}\/compare/);
  assert.match(panel, /request<CollaborationReviewCompareResult>/);
  assert.match(panel, /setComparison\(response\.data\.comparison\)/);
  assert.match(types, /interface CollaborationReviewComparison \{[\s\S]*nodes: CollaborationReviewComparisonCollection;[\s\S]*edges: CollaborationReviewComparisonCollection;[\s\S]*viewportChanged: boolean;/);
  assert.match(panel, /safeComparisonLines\(comparison\)/);
  assert.doesNotMatch(section(panel, 'function safeComparisonLines', 'function timestampLabel'), /before|after|prompt|modelParameters/i);
});

test('F6 review list metadata and export are materialized from one SQLite read snapshot', () => {
  const exportRoute = section(gateway, "app.get('/api/collab/reviews/export'", "app.get('/api/collab/reviews'");
  const listRoute = section(gateway, "app.get('/api/collab/reviews'", "app.get('/api/collab/reviews/:threadId/compare'");
  for (const route of [exportRoute, listRoute]) {
    assert.match(route, /withProjectDatabaseReadSnapshot\(/);
    assert.match(route, /const document = this\.ensureCanvasAccess/);
    assert.match(route, /publicReviewThreadForSession\(/);
  }
  assert.match(exportRoute, /materializeReviewThreadExport\(countFilters, 1000\)/);
  assert.match(listRoute, /const records = this\.database\.listReviewThreads\(filters\)/);
  assert.match(listRoute, /total: this\.database\.countReviewThreads\(countFilters\)/);
});

test('Workspace preserves public response meta, refreshes F6 on websocket events and mounts one review panel', () => {
  assert.match(workspace, /async function collabEnvelopeRequest<T>/);
  assert.match(workspace, /isPlainRecord\(payload\.meta\) \? \{ meta: payload\.meta \} : \{\}/);
  assert.match(workspace, /'review\.created', 'review\.updated', 'review\.comment', 'review\.notification', 'notification\.created'/);
  assert.match(workspace, /setReviewRefreshToken\(\(current\) => current \+ 1\)/);
  assert.equal((workspace.match(/<CollaborationReviewPanel\b/g) || []).length, 1);
  assert.match(workspace, /request=\{scopedCollaborationReviewRequest\}/);
  assert.match(workspace, /recoveryGeneration: fence\.recoveryGeneration/);
  assert.match(workspace, /assertCurrent: \(\) => assertMutationFenceCurrent\(fence\)/);
  assert.match(workspace, /canvasRevision=\{document\.revision\}/);
  assert.doesNotMatch(workspace, /const updateReview =|const submitComment =/);
});

test('owner review visibility policy uses a complete revision-CAS API and a local management UI', () => {
  assert.match(types, /interface CollaborationReviewVisibilityPolicy \{[\s\S]*revision: number;[\s\S]*hidePrompts: boolean;[\s\S]*hideModelParameters: boolean;/);
  assert.match(types, /interface CollaborationReviewVisibilityPolicyInput \{[\s\S]*expectedRevision: number;[\s\S]*hidePrompts: boolean;[\s\S]*hideModelParameters: boolean;/);
  assert.match(api, /export async function getCollaborationReviewVisibilityPolicy/);
  assert.match(api, /collaboration\/review-visibility-policy\?\$\{params\.toString\(\)\}/);
  assert.match(api, /export async function updateCollaborationReviewVisibilityPolicy/);
  assert.match(api, /method: 'PUT'/);
  assert.match(api, /body: JSON\.stringify\(\{ projectId, \.\.\.input \}\)/);
  assert.match(hostPanel, /data-testid="collaboration-review-visibility-policy"/);
  assert.match(hostPanel, /api\.getCollaborationReviewVisibilityPolicy\(projectId, \{ signal: controller\.signal \}\)/);
  assert.match(hostPanel, /expectedRevision: reviewVisibilityPolicy\.revision,/);
  assert.match(hostPanel, /hidePrompts: hideReviewPrompts,/);
  assert.match(hostPanel, /hideModelParameters: hideReviewModelParameters,/);
  assert.match(hostPanel, /reviewVisibilityPolicy\.revision < 0/);
  assert.match(hostPanel, /审片可见性策略尚未完成权威载入，不能盲写/);
  assert.match(hostPanel, /仅 owner 可在本机管理端修改/);
});
