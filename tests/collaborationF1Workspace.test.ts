import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const workspace = readFileSync(
  new URL('../src/components/CollaborationWorkspace.tsx', import.meta.url),
  'utf8',
);

test('collaboration invite is redeemed before an existing cookie and the session canvas is authoritative', () => {
  assert.match(workspace, /interface Session \{[\s\S]*canvasId: string;/);
  assert.match(workspace, /const invite = params\.get\('invite'\) \|\| '';/);
  assert.match(workspace, /if \(invite\) \{[\s\S]*\/api\/collab\/invites\/redeem[\s\S]*\} else \{[\s\S]*\/api\/collab\/session/);
  assert.match(workspace, /\.\.\.\(requestedCanvasId \? \{ canvasId: requestedCanvasId \} : \{\}\)/);
  assert.match(workspace, /requestedCanvasId && requestedCanvasId !== nextSession\.canvasId/);
  assert.match(workspace, /nextCanvases\.length !== 1 \|\| nextCanvases\[0\]\?\.id !== nextSession\.canvasId/);
  assert.match(workspace, /await loadCanvas\(nextSession\.canvasId\)/);
  assert.doesNotMatch(workspace, /nextCanvases\.find\([\s\S]*\) \|\| nextCanvases\[0\]/);
  assert.match(workspace, /url\.searchParams\.delete\('invite'\)/);
  assert.match(workspace, /history\.replaceState\(history\.state, '', `\$\{url\.pathname\}\$\{url\.search\}\$\{url\.hash\}`\)/);
  assert.match(workspace, /\/api\/collab\/invites\/redeem[\s\S]*removeInviteFromAddressBar\(\)/);
});

test('remote workspace cannot switch away from the session canvas and websocket joins only that scope', () => {
  assert.match(workspace, /const canvasId = session\?\.canvasId \|\| '';/);
  assert.match(workspace, /data-testid="collaboration-scoped-canvas"/);
  assert.doesNotMatch(workspace, /onChange=\{\(event\) => void loadCanvas\(event\.target\.value\)\}/);
  assert.match(workspace, /socket\.onopen = \(\) => socket\.send\(JSON\.stringify\(\{ type: 'canvas\.join', canvasId: session\.canvasId \}\)\)/);
  assert.doesNotMatch(workspace, /canvas\.join', canvasId: (?:id|canvasId)/);
});

test('viewer and reviewer connections remain structurally read-only in the local React Flow state', () => {
  assert.match(workspace, /deleteKeyCode=\{null\}/);
  assert.match(workspace, /changes\.filter\(\(change\) => change\.type === 'select' \|\| change\.type === 'dimensions'\)/);
  assert.match(workspace, /nodesDraggable=\{canEdit\}/);
  assert.match(workspace, /data-testid="collaboration-access-mode"/);
  assert.match(workspace, /审阅连接 · 画布只读/);
  assert.match(workspace, /查看连接 · 完全只读/);
});

test('host revocation and gateway shutdown are surfaced immediately to the remote workspace', () => {
  assert.match(workspace, /message\.type === 'session\.revoked'/);
  assert.match(workspace, /message\.type === 'session\.changed'/);
  assert.match(workspace, /event\.code === 4002/);
  assert.match(workspace, /collabRequest<Session>\('\/api\/collab\/session'\)/);
  assert.match(workspace, /nextSession\.canvasId !== session\.canvasId/);
  assert.match(workspace, /socket\.onclose = \(event\) =>/);
  assert.match(workspace, /event\.code === 4001/);
  assert.match(workspace, /webSocketRef\.current\?\.readyState !== WebSocket\.OPEN/);
});
