import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const workspace = readFileSync(
  new URL('../src/components/CollaborationWorkspace.tsx', import.meta.url),
  'utf8',
);
const connection = readFileSync(
  new URL('../src/utils/collaborationConnection.ts', import.meta.url),
  'utf8',
);

test('collaboration invite is redeemed before an existing cookie and the session canvas is authoritative', () => {
  assert.match(workspace, /interface Session \{[\s\S]*canvasId: string;/);
  assert.match(workspace, /const invite = params\.get\('invite'\) \|\| '';/);
  assert.match(workspace, /if \(invite\) \{[\s\S]*\/api\/collab\/invites\/redeem[\s\S]*\} else \{[\s\S]*\/api\/collab\/session/);
  assert.match(workspace, /\.\.\.\(requestedCanvasId \? \{ canvasId: requestedCanvasId \} : \{\}\)/);
  assert.match(workspace, /requestedCanvasId && requestedCanvasId !== nextSession\.canvasId/);
  assert.match(workspace, /nextCanvases\.length !== 1 \|\| nextCanvases\[0\]\?\.id !== nextSession\.canvasId/);
  assert.match(workspace, /await loadCanvas\(nextSession\.canvasId, \{/);
  assert.doesNotMatch(workspace, /nextCanvases\.find\([\s\S]*\) \|\| nextCanvases\[0\]/);
  assert.match(workspace, /url\.searchParams\.delete\('invite'\)/);
  assert.match(workspace, /history\.replaceState\(history\.state, '', `\$\{url\.pathname\}\$\{url\.search\}\$\{url\.hash\}`\)/);
  assert.match(workspace, /\/api\/collab\/invites\/redeem[\s\S]*removeInviteFromAddressBar\(\)/);
});

test('remote workspace cannot switch away from the session canvas and websocket joins only that scope', () => {
  assert.match(workspace, /const canvasId = session\?\.canvasId \|\| '';/);
  assert.match(workspace, /const queueScopeReady = sameCollaborationQueueScope\(renderedQueueScope, queueScopeRef\.current\);/);
  assert.match(workspace, /const socketScopeReady = Boolean\([\s\S]*document\?\.canvasId === session\.canvasId[\s\S]*queueScopeReady/);
  assert.match(workspace, /if \(!session \|\| !socketScopeReady \|\| !authoritativeDocumentRef\.current\) return;/);
  assert.match(workspace, /recoverCanvas,[\s\S]*session,[\s\S]*socketScopeReady,[\s\S]*updateConnectionState,/);
  assert.match(workspace, /data-testid="collaboration-scoped-canvas"/);
  assert.doesNotMatch(workspace, /onChange=\{\(event\) => void loadCanvas\(event\.target\.value\)\}/);
  assert.match(workspace, /socket\.onopen = \(\) => \{[\s\S]*type: 'canvas\.join',[\s\S]*canvasId: session\.canvasId,[\s\S]*afterRevision: authoritativeDocumentRef\.current\?\.revision \|\| 0/);
  assert.doesNotMatch(workspace, /canvas\.join', canvasId: (?:id|canvasId)/);
});

test('viewer and reviewer connections remain structurally read-only in the local React Flow state', () => {
  assert.match(workspace, /deleteKeyCode=\{canEdit \? \['Backspace', 'Delete'\] : null\}/);
  assert.match(workspace, /nodesConnectable=\{canEdit\}/);
  assert.match(workspace, /const permittedChanges = changes\.filter\(\(change\) => \([\s\S]*change\.type === 'select'[\s\S]*change\.type === 'dimensions'[\s\S]*canEdit && change\.type === 'position'/);
  assert.match(workspace, /nodesDraggable=\{canEdit\}/);
  assert.match(workspace, /data-testid="collaboration-access-mode"/);
  assert.match(workspace, /审阅连接 · 画布只读/);
  assert.match(workspace, /查看连接 · 完全只读/);
});

test('offline replay validates the exact HTTP acknowledgement before accepting state or deleting the queue head', () => {
  const start = workspace.indexOf('const flushOfflineQueue = useCallback');
  const end = workspace.indexOf('useEffect(() => {', start);
  const flush = workspace.slice(start, end);
  const fenceIndex = flush.indexOf('const mutationFence = captureMutationFence()');
  const requestIndex = flush.indexOf('collaborationMutationRequest<unknown>');
  const validationIndex = flush.indexOf('acceptCollaborationMoveMutationResult(result');
  const acceptIndex = flush.indexOf('acceptAuthoritativeDocument(confirmed.document)');
  const removeIndex = flush.indexOf('removeCollaborationQueueItem(offlineQueueRef.current, item.id)');
  assert.ok(fenceIndex >= 0 && requestIndex > fenceIndex, 'operations response must use the captured immutable mutation fence');
  assert.ok(validationIndex > requestIndex, 'exact acknowledgement validation must follow the request');
  assert.ok(acceptIndex > validationIndex, 'authoritative state must not be accepted before ACK validation');
  assert.ok(removeIndex > validationIndex, 'queue head must not be deleted before ACK validation');
  assert.doesNotMatch(flush, /collabRequest<\{ document: VersionedCanvasData \}>/);
});

test('host revocation and gateway shutdown are surfaced immediately to the remote workspace', () => {
  assert.match(workspace, /message\.type === 'session\.revoked'/);
  assert.match(workspace, /message\.type === 'session\.changed'/);
  assert.match(workspace, /classifyCollaborationClose\(event\.code, event\.reason, gatewayNotice\)/);
  assert.match(connection, /if \(code === 4002\)/);
  assert.match(workspace, /collabRequest<Session>\('\/api\/collab\/session'\)/);
  assert.match(workspace, /nextSession\.canvasId !== session\.canvasId/);
  assert.match(workspace, /socket\.onclose = \(event\) =>/);
  assert.match(connection, /if \(code === 4001\)/);
  assert.match(workspace, /message\.type === 'gateway\.stopping'/);
  assert.match(connection, /code === 4004[\s\S]*host_stopped/);
  assert.match(workspace, /connectionStateRef\.current\.phase !== 'online'/);
});
