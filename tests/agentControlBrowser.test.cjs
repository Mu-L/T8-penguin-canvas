'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  AgentControlBrowserError,
  createBrowserHandoff,
  localCanvasOrigin,
} = require('../backend/src/services/agentControlBrowser.js');

test('browser handoff is bound to one local origin and declares zero private browser reads', () => {
  const handoff = createBrowserHandoff({
    action: 'highlight',
    userInitiated: true,
    projectId: 'project-local',
    canvasId: 'canvas-a',
    nodeId: '角色节点-1',
  }, {
    IS_PACKAGED: true,
    PORT: 18766,
  });
  const handoffUrl = new URL(handoff.url);
  assert.equal(handoffUrl.origin, 'http://127.0.0.1:18766');
  assert.equal(handoffUrl.searchParams.get('zcanvasHandoff'), handoff.handoffId);
  assert.equal(handoffUrl.searchParams.get('zcanvasAction'), 'highlight');
  assert.equal(handoffUrl.searchParams.get('zcanvasCanvasId'), 'canvas-a');
  assert.equal(handoffUrl.searchParams.get('zcanvasNodeId'), '角色节点-1');
  assert.equal(handoff.allowedOrigin, 'http://127.0.0.1:18766');
  assert.deepEqual(handoff.allowedOrigins, ['http://127.0.0.1:18766']);
  assert.equal(handoff.scope, 'current-tab-only');
  assert.equal(handoff.navigationPolicy, 'local-canvas-origin-only');
  assert.equal(handoff.credentialMode, 'omit');
  assert.equal(handoff.userInitiated, true);
  assert.equal(handoff.readsCookies, false);
  assert.equal(handoff.readsProfile, false);
  assert.equal(handoff.readsOtherTabs, false);
  assert.equal(handoff.readsStorage, false);
  assert.equal(handoff.hostActionRequired, true);
  assert.equal(handoff.executed, false);
  assert.equal(handoff.executionStatus, 'handoff-only');
  assert.equal(handoff.nodeId, '角色节点-1');
  assert.equal(handoff.fallback.available, true);
  assert.match(handoff.handoffId, /^[0-9a-f-]{36}$/);
});

test('browser handoff rejects missing targets and non-local configured origins', () => {
  assert.throws(
    () => createBrowserHandoff({
      action: 'highlight',
      userInitiated: true,
      projectId: 'project-local',
      canvasId: 'canvas-a',
    }, { IS_PACKAGED: true, PORT: 18766 }),
    (error) => error instanceof AgentControlBrowserError && error.code === 'BROWSER_TARGET_REQUIRED',
  );

  const previous = process.env.T8PC_FRONTEND_URL;
  process.env.T8PC_FRONTEND_URL = 'https://example.com/canvas';
  try {
    assert.throws(
      () => localCanvasOrigin({ IS_PACKAGED: false, PORT: 18766 }),
      (error) => error instanceof AgentControlBrowserError && error.code === 'BROWSER_ORIGIN_FORBIDDEN',
    );
  } finally {
    if (previous == null) delete process.env.T8PC_FRONTEND_URL;
    else process.env.T8PC_FRONTEND_URL = previous;
  }
});

test('interactive browser handoff requires an explicit user command while status stays read-only', () => {
  assert.throws(
    () => createBrowserHandoff({
      action: 'open',
      projectId: 'project-local',
      canvasId: 'canvas-a',
    }, { IS_PACKAGED: true, PORT: 18766 }),
    (error) => error instanceof AgentControlBrowserError
      && error.code === 'BROWSER_EXPLICIT_REQUEST_REQUIRED',
  );

  const status = createBrowserHandoff({
    action: 'status',
    projectId: 'project-local',
    canvasId: 'canvas-a',
  }, { IS_PACKAGED: true, PORT: 18766 });
  assert.equal(status.userInitiated, false);
  assert.equal(status.hostActionRequired, false);
  assert.equal(status.executionStatus, 'not-applicable');
  assert.equal(status.credentialMode, 'omit');
});

test('browser handoff rejects arbitrary navigation and inherited browser authority fields', () => {
  const authorityExpansions = [
    { url: 'https://example.com' },
    { cookies: 'session=secret' },
    { profile: 'Default' },
    { localStorage: { token: 'secret' } },
  ];
  for (const extra of authorityExpansions) {
    assert.throws(
      () => createBrowserHandoff({
        action: 'open',
        userInitiated: true,
        projectId: 'project-local',
        canvasId: 'canvas-a',
        ...extra,
      }, { IS_PACKAGED: true, PORT: 18766 }),
      (error) => error instanceof AgentControlBrowserError
        && error.code === 'BROWSER_AUTHORITY_EXPANSION_FORBIDDEN',
    );
  }
});
