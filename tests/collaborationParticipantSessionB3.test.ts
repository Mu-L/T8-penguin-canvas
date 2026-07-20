import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (relativePath: string) => readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');
const api = read('src/services/api.ts');
const workspace = read('src/components/CollaborationWorkspace.tsx');
const gateway = read('backend/src/collaboration/gateway.js');

function functionSource(source: string, name: string, nextName?: string) {
  const start = source.indexOf(`export async function ${name}`);
  assert.ok(start >= 0, `${name} must be exported`);
  const next = nextName ? source.indexOf(`export async function ${nextName}`, start + 1) : -1;
  return source.slice(start, next >= 0 ? next : source.length);
}

test('participant API wraps only the current cookie session and never models a readable token', () => {
  const logout = functionSource(api, 'logoutCurrentCollaborationSession', 'rotateCurrentCollaborationSession');
  const rotate = functionSource(api, 'rotateCurrentCollaborationSession', 'createCollaborationInvite');
  const participantType = api.match(/export interface CollaborationParticipantSession \{[\s\S]*?\n\}/)?.[0] || '';

  assert.match(logout, /`\$\{BASE\}\/collab\/logout`/);
  assert.match(logout, /method: 'POST'/);
  assert.match(logout, /credentials: 'same-origin'/);
  assert.match(rotate, /`\$\{BASE\}\/collab\/session\/rotate`/);
  assert.match(rotate, /credentials: 'same-origin'/);
  assert.match(rotate, /'X-T8-Canvas-Generation': recoveryGeneration/);
  assert.match(rotate, /return res\.data/);
  assert.match(participantType, /authorizationEpoch: number/);
  assert.doesNotMatch(participantType, /\btoken\b/i);
  assert.doesNotMatch(logout, /sessionId|memberId|projectId|canvasId/);
});

test('workspace requires explicit confirmation and preserves session scope during rotation', () => {
  const start = workspace.indexOf('const rotateParticipantSession = useCallback');
  const end = workspace.indexOf('const logoutParticipantSession = useCallback', start);
  const rotate = workspace.slice(start, end);
  const confirmation = rotate.indexOf("participantSessionConfirmation !== 'rotate'");
  const fence = rotate.indexOf('const mutationFence = captureMutationFence()');
  const request = rotate.indexOf('rotateCurrentCollaborationSession(mutationFence.recoveryGeneration)');
  const staleGuard = rotate.indexOf('assertMutationFenceCurrent(mutationFence)');
  const validation = rotate.indexOf('isSafeRotatedParticipantSession(rotated, current)');
  const scopeActivation = rotate.indexOf('activateQueueScope(');
  const sessionReplacement = rotate.indexOf('sessionRef.current = rotated');

  assert.ok(confirmation >= 0 && fence > confirmation && request > fence, 'rotation must follow a second explicit click and capture its generation/epoch');
  assert.match(rotate, /offlineQueueRef\.current\.length > 0/);
  assert.ok(staleGuard > request && validation > staleGuard, 'stale rotation responses must be rejected before identity validation');
  assert.ok(scopeActivation > validation, 'queue scope must change only after identity validation');
  assert.ok(sessionReplacement > scopeActivation, 'new session must be installed after old-scope queue handling');
  assert.match(workspace, /value\.id === previous\.id/);
  assert.match(workspace, /value\.projectId !== previous\.projectId/);
  assert.match(workspace, /value\.canvasId !== previous\.canvasId/);
  assert.match(workspace, /value\.memberId !== previous\.memberId/);
  assert.match(workspace, /data-testid="collaboration-participant-session-rotate"/);
  assert.match(workspace, /queueStats\.operations > 0/);
});

test('workspace self-logout is two-step and clears visible collaboration content only after success', () => {
  const clearStart = workspace.indexOf('const clearVisibleWorkspaceAfterLogout = useCallback');
  const start = workspace.indexOf('const logoutParticipantSession = useCallback');
  const end = workspace.indexOf('useEffect(() => { void bootstrap();', start);
  const clearVisible = workspace.slice(clearStart, start);
  const logout = workspace.slice(start, end);
  const confirmation = logout.indexOf("participantSessionConfirmation !== 'logout'");
  const request = logout.indexOf('await logoutCurrentCollaborationSession()');
  const clear = logout.indexOf('clearVisibleWorkspaceAfterLogout()');

  assert.ok(confirmation >= 0 && request > confirmation, 'logout must follow a second explicit click');
  assert.ok(clear > request, 'visible state must clear only after the server confirms revocation');
  assert.match(logout, /未提交操作；退出后不会自动重放/);
  assert.match(workspace, /data-testid="collaboration-participant-session-logout"/);
  assert.match(workspace, /setSession\(null\)/);
  assert.match(workspace, /setDocument\(null\)/);
  assert.match(workspace, /setNodes\(\[\]\)/);
  assert.match(workspace, /setEdges\(\[\]\)/);
  assert.match(clearVisible, /setOfflineQueue\(\[\]\)/);
  assert.doesNotMatch(clearVisible, /sessionStorage\.removeItem|\.removeItem\(queueStorageKeyRef/);
  assert.match(workspace, /当前参与者已退出，旧会话凭据已撤销/);
});

test('gateway contracts behind participant actions remain self-scoped and token-redacted', () => {
  const logoutStart = gateway.indexOf("app.post('/api/collab/logout'");
  const rotateStart = gateway.indexOf("app.post('/api/collab/session/rotate'");
  const logout = gateway.slice(logoutStart, gateway.indexOf("app.use('/api/collab/common-operations'", logoutStart));
  const rotate = gateway.slice(rotateStart, gateway.indexOf("app.get('/api/collab/canvases'", rotateStart));

  assert.match(logout, /this\.auth\.revoke\(req\.collaborationSession\.id/);
  assert.match(logout, /this\.closeSessionConnections\(req\.collaborationSession\.id/);
  assert.match(logout, /clearSessionCookie\(req\)/);
  assert.match(rotate, /this\.auth\.rotate\(req\.collaborationSession\)/);
  assert.match(rotate, /const \{ token: _token, \.\.\.session \} = rotated/);
  assert.match(rotate, /WS_CLOSE_SESSION_CHANGED/);
  assert.match(rotate, /messageType: 'session\.changed'/);
});
