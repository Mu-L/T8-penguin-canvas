import test from 'node:test';
import assert from 'node:assert/strict';
import type { RunActionPreview } from '../src/utils/runPreflight.ts';
import {
  authorizeRunPreflight,
  isSameRunPreflightExecutionSnapshot,
  type RunPreflightExecutionSnapshot,
} from '../src/utils/runPreflightExecution.ts';

const snapshot: RunPreflightExecutionSnapshot = {
  projectId: 'project-a',
  canvasId: 'canvas-a',
  revision: 7,
  graphMutationEpoch: 11,
};

function preview(overrides: Partial<RunActionPreview> = {}): RunActionPreview {
  return {
    schema: 't8-run-action-preview-v1',
    actionKind: 'run-all',
    status: 'confirmation-required',
    requiresExplicitConfirmation: true,
    scope: {
      projectId: 'project-a', canvasId: 'canvas-a', currentRevision: 7, expectedRevision: 7,
      requestId: null, hostContextDigest: `sha256:${'a'.repeat(64)}`, nodeIds: ['node-a'], selectedNodeCount: 1, canvasNodeCount: 1,
      canvasEdgeCount: 0, nodeIdsTruncated: false, nodeSetDigest: 'fnv1a32:scope',
      executionGraphDigest: 'fnv1a32:graph',
    },
    evidenceRefs: [],
    cost: { known: false, reason: 'not-authoritatively-known' },
    blockers: [],
    warnings: [{ domain: 'cost', code: 'cost.unknown', message: 'unknown', nodeIds: [] }],
    digestAlgorithm: 'fnv1a32-stable-json-v1',
    digest: 'fnv1a32:preview',
    ...overrides,
  };
}

function advisoryPreview(overrides: Partial<RunActionPreview> = {}): RunActionPreview {
  return preview({
    status: 'ready',
    requiresExplicitConfirmation: false,
    ...overrides,
  });
}

test('snapshot comparison binds project, canvas, revision, and graph mutation epoch', () => {
  assert.equal(isSameRunPreflightExecutionSnapshot(snapshot, { ...snapshot }), true);
  for (const changed of [
    { ...snapshot, projectId: 'project-b' },
    { ...snapshot, canvasId: 'canvas-b' },
    { ...snapshot, revision: 8 },
    { ...snapshot, graphMutationEpoch: 12 },
  ]) assert.equal(isSameRunPreflightExecutionSnapshot(snapshot, changed), false);
  assert.equal(isSameRunPreflightExecutionSnapshot(snapshot, null), false);
});

test('blocked preview is inspectable but never authorizes execution', async () => {
  const calls: string[] = [];
  const blocked = preview({ status: 'blocked', blockers: [{ domain: 'asset', code: 'asset.missing', message: 'missing', nodeIds: ['node-a'] }] });
  const result = await authorizeRunPreflight({
    snapshot,
    signal: new AbortController().signal,
    prepare: async () => { calls.push('prepare'); return blocked; },
    captureCurrent: () => ({ ...snapshot }),
    present: async () => { calls.push('present'); return true; },
    revalidate: () => { calls.push('revalidate'); return blocked; },
  });
  assert.deepEqual(calls, ['prepare', 'present']);
  assert.deepEqual(result, { authorized: false, reason: 'blocked', preview: blocked });
});

test('cancelling an explicit retry/replay confirmation has no authorization side effect', async () => {
  const candidate = preview({ actionKind: 'retry-run' });
  const result = await authorizeRunPreflight({
    snapshot,
    signal: new AbortController().signal,
    prepare: async () => candidate,
    captureCurrent: () => ({ ...snapshot }),
    present: async () => false,
    revalidate: () => { throw new Error('must not revalidate after cancellation'); },
  });
  assert.equal(result.authorized, false);
  assert.equal(result.reason, 'cancelled');
});

test('ordinary advisory warnings authorize without presenting an interrupting dialog', async () => {
  const candidate = advisoryPreview();
  const calls: string[] = [];
  const result = await authorizeRunPreflight({
    snapshot,
    signal: new AbortController().signal,
    prepare: async () => { calls.push('prepare'); return candidate; },
    captureCurrent: () => ({ ...snapshot }),
    present: async () => { calls.push('present'); return false; },
    revalidate: async () => { calls.push('revalidate'); return candidate; },
  });
  assert.deepEqual(calls, ['prepare', 'revalidate']);
  assert.equal(result.authorized, true);
});

test('confirmation is followed by final identity/revision/graph recheck', async () => {
  const candidate = preview();
  let current = { ...snapshot };
  const result = await authorizeRunPreflight({
    snapshot,
    signal: new AbortController().signal,
    prepare: async () => candidate,
    captureCurrent: () => ({ ...current }),
    present: async () => { current = { ...current, graphMutationEpoch: current.graphMutationEpoch + 1 }; return true; },
    revalidate: () => { throw new Error('stale graph must not revalidate'); },
  });
  assert.equal(result.authorized, false);
  assert.equal(result.reason, 'stale');
});

test('changed final preview digest fails closed; exact final preview authorizes', async () => {
  const candidate = preview();
  const base = {
    snapshot,
    signal: new AbortController().signal,
    prepare: async () => candidate,
    captureCurrent: () => ({ ...snapshot }),
    present: async () => true,
  };
  const changed = await authorizeRunPreflight({ ...base, revalidate: () => preview({ digest: 'fnv1a32:changed' }) });
  assert.equal(changed.authorized, false);
  assert.equal(changed.reason, 'stale');

  const exact = await authorizeRunPreflight({ ...base, revalidate: () => candidate });
  assert.equal(exact.authorized, true);
  assert.equal(exact.reason, 'authorized');
});

test('async final host-context refresh is awaited and an abort during refresh cancels authorization', async () => {
  const candidate = preview();
  const controller = new AbortController();
  const calls: string[] = [];
  const result = await authorizeRunPreflight({
    snapshot,
    signal: controller.signal,
    prepare: async () => candidate,
    captureCurrent: () => ({ ...snapshot }),
    present: async () => true,
    revalidate: async () => {
      calls.push('refresh-start');
      await Promise.resolve();
      controller.abort();
      calls.push('refresh-finished');
      return candidate;
    },
  });
  assert.deepEqual(calls, ['refresh-start', 'refresh-finished']);
  assert.equal(result.authorized, false);
  assert.equal(result.reason, 'cancelled');
});
