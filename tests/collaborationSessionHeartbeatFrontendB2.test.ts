import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const workspace = readFileSync(
  new URL('../src/components/CollaborationWorkspace.tsx', import.meta.url),
  'utf8',
);
const connection = readFileSync(
  new URL('../src/utils/collaborationConnection.ts', import.meta.url),
  'utf8',
);
const projectRoot = fileURLToPath(new URL('..', import.meta.url));
let runtimeCollabEnvelopeRequest: any;

test.before(async () => {
  const result = await build({
    absWorkingDir: projectRoot,
    stdin: {
      contents: "export { collabEnvelopeRequest } from './src/components/CollaborationWorkspace.tsx';",
      resolveDir: projectRoot,
      sourcefile: 'collaboration-heartbeat-runtime-entry.ts',
    },
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    logLevel: 'silent',
    loader: { '.css': 'empty' },
    treeShaking: true,
  });
  const source = result.outputFiles[0].text;
  const runtime = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  runtimeCollabEnvelopeRequest = runtime.collabEnvelopeRequest;
  assert.equal(typeof runtimeCollabEnvelopeRequest, 'function');
});

function durableHeartbeatEffectSource() {
  const start = workspace.indexOf('const generation = ++sessionHeartbeatGenerationRef.current');
  const end = workspace.indexOf('const restoreVisibleNodes = useCallback', start);
  assert.ok(start >= 0, 'durable heartbeat generation boundary is missing');
  assert.ok(end > start, 'durable heartbeat effect boundary is missing');
  return workspace.slice(start, end);
}

test('B2 durable session heartbeat is separate from the five-second WebSocket liveness loop', () => {
  const effect = durableHeartbeatEffectSource();
  assert.match(connection, /COLLABORATION_HEARTBEAT_INTERVAL_MS = 5_000/);
  assert.match(connection, /COLLABORATION_SESSION_HEARTBEAT_INTERVAL_MS = 60_000/);
  assert.match(workspace, /heartbeatTimer = window\.setInterval/);
  assert.match(effect, /window\.setTimeout\(callback, COLLABORATION_SESSION_HEARTBEAT_INTERVAL_MS\)/);
  assert.doesNotMatch(effect, /setInterval/);
  assert.match(effect, /\/api\/collab\/session\/heartbeat/);
  assert.match(effect, /body: JSON\.stringify\(identity\)/);
  assert.match(effect, /collabRequest<\{/);
  assert.match(effect, /recoveryGeneration: null/);
  assert.match(effect, /assertCurrent: \(\) => assertMutationFenceCurrent\(mutationFence\)/);
  assert.doesNotMatch(effect, /collaborationMutationRequest/);
});

test('B2 heartbeat runtime fetch stays headerless for canvas recovery generation', async () => {
  const originalFetch = globalThis.fetch;
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  let assertCurrentCalls = 0;
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    writable: true,
    value: {
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
    },
  });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ input, init });
    return new Response(JSON.stringify({
      success: true,
      data: { touched: false, lastSeenAt: 100, nextHeartbeatAt: 160 },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    const response = await runtimeCollabEnvelopeRequest(
      '/api/collab/session/heartbeat',
      {
        method: 'POST',
        body: JSON.stringify({
          sessionId: 'session-heartbeat',
          projectId: 'project-heartbeat',
          canvasId: 'canvas-heartbeat',
          memberId: 'member-heartbeat',
          authorizationEpoch: 3,
        }),
      },
      {
        recoveryGeneration: null,
        assertCurrent: () => { assertCurrentCalls += 1; },
      },
    );

    assert.equal(calls.length, 1);
    assert.equal(String(calls[0].input), '/api/collab/session/heartbeat');
    assert.equal(calls[0].init?.method, 'POST');
    assert.equal(calls[0].init?.credentials, 'same-origin');
    const headers = new Headers(calls[0].init?.headers);
    assert.equal(headers.get('Content-Type'), 'application/json');
    assert.equal(headers.has('X-T8-Canvas-Generation'), false);
    assert.deepEqual(response.data, { touched: false, lastSeenAt: 100, nextHeartbeatAt: 160 });
    assert.ok(assertCurrentCalls >= 2, 'runtime transport must fence both sides of fetch');
  } finally {
    globalThis.fetch = originalFetch;
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else delete (globalThis as { window?: unknown }).window;
  }
});

test('B2 durable session heartbeat is single-flight, cancellable, and stale-session safe', () => {
  const effect = durableHeartbeatEffectSource();
  assert.match(workspace, /sessionHeartbeatSingleFlightRef = useRef<CollaborationSessionHeartbeatSingleFlight/);
  assert.match(effect, /singleFlight\.run\(generation, async \(signal\) =>/);
  assert.match(effect, /if \(signal\.aborted \|\| !isCurrent\(\)\) return;/);
  assert.match(effect, /singleFlight\.cancel\(generation\)/);
  assert.doesNotMatch(effect, /let inFlight|requestController/);
  assert.match(effect, /sessionHeartbeatGenerationRef\.current !== generation/);
  assert.match(effect, /webSocketRef\.current !== socket/);
  assert.match(effect, /connectionStateRef\.current\.phase !== 'online'/);
  assert.match(effect, /collaborationSessionHeartbeatIdentity\(sessionRef\.current\)/);
  assert.match(effect, /sameCollaborationSessionHeartbeatIdentity/);
  assert.match(effect, /schedule\(\(\) => \{ void heartbeat\(\); \}\)/);
});

test('B2 heartbeat terminal failures close the exact socket while transient failures stay non-disruptive', () => {
  const effect = durableHeartbeatEffectSource();
  assert.match(effect, /action === 'revoke'[\s\S]*socket\.close\(4001/);
  assert.match(effect, /action === 'block'[\s\S]*socket\.close\(1008/);
  assert.match(effect, /action === 'refresh-session'[\s\S]*socket\.close\(4002/);
  assert.match(effect, /console\.warn\('\[collaboration\] durable session heartbeat deferred'\)/);
  const warningIndex = effect.indexOf("console.warn('[collaboration] durable session heartbeat deferred')");
  const transientBranch = effect.slice(effect.lastIndexOf("if (action === 'refresh-session')", warningIndex), warningIndex);
  assert.doesNotMatch(transientBranch, /status\s*\)|setStatus|socket\.close\([^4]/);
  assert.doesNotMatch(effect, /console\.(?:warn|error)\([^)]*error/);
});
