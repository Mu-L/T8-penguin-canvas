import assert from 'node:assert/strict';
import test from 'node:test';
import {
  activateCanvasPatchPending,
  advanceCanvasPatchMutation,
  beginCanvasPatchSingleFlight,
  canvasPatchHistoryBarrier,
  canvasPatchScopeKey,
  endCanvasPatchSingleFlight,
  mergeCanvasPatchGraph,
  mergeCanvasPatchValueWithConflicts,
  reconcileCanvasPatchAutosavePending,
  reconcileCanvasPatchAutosaveResponse,
  type CanvasPatchPendingEnvelope,
} from '../src/utils/canvasPatchMerge.ts';
import {
  captureCanvasHistoryState,
  createCanvasHistoryState,
  undoCanvasHistoryState,
} from '../src/hooks/useCanvasHistory.ts';

type GraphNode = { id: string; data?: Record<string, unknown> };
type GraphEdge = { id: string; source: string; target: string; data?: Record<string, unknown> };

function pending(overrides: Partial<CanvasPatchPendingEnvelope> = {}): CanvasPatchPendingEnvelope {
  return {
    snapshot: 'local-r7',
    baseSnapshot: 'authoritative-r7',
    baseRevision: 7,
    conflicted: false,
    conflicts: [],
    ...overrides,
  };
}

test('dirty 409 pending remains based on its original authority and activation never marks it saved', () => {
  const result = activateCanvasPatchPending({
    authoritativeSnapshot: 'authoritative-r8',
    authoritativeRevision: 8,
    pending: pending({
      conflicted: true,
      conflicts: [{ kind: 'same-field', path: 'nodes[n1].data.prompt' }],
    }),
  });

  assert.equal(result.lastSavedSnapshot, 'authoritative-r8');
  assert.equal(result.pending?.snapshot, 'local-r7');
  assert.equal(result.pending?.baseSnapshot, 'authoritative-r7');
  assert.equal(result.pending?.baseRevision, 7);
  assert.equal(result.blocked, true);
  assert.equal(result.shouldScheduleCas, false);
});

test('inactive Patch merge is rebased on activation and schedules a CAS without pretending it is saved', () => {
  const result = activateCanvasPatchPending({
    authoritativeSnapshot: 'authoritative-r9',
    authoritativeRevision: 9,
    pending: pending({
      snapshot: 'merged-local-r9',
      baseSnapshot: 'authoritative-r9',
      baseRevision: 9,
    }),
  });

  assert.equal(result.lastSavedSnapshot, 'authoritative-r9');
  assert.equal(result.pending?.baseSnapshot, 'authoritative-r9');
  assert.equal(result.pending?.baseRevision, 9);
  assert.equal(result.blocked, false);
  assert.equal(result.shouldScheduleCas, true);
});

test('A to local to A autosave reconciliation cancels the stale local timer and removes clean pending state', () => {
  const result = reconcileCanvasPatchAutosavePending({
    authoritativeSnapshot: 'A',
    current: pending({ snapshot: 'A' }),
    pending: pending({ snapshot: 'L' }),
  });

  assert.equal(result.cancelTimer, true);
  assert.equal(result.shouldReturn, true);
  assert.equal(result.pending, null);
});

test('dirty conflict returning to the old authority cancels its timer but retains conflict provenance', () => {
  const conflicts = [{ kind: 'same-field' as const, path: 'revision' }];
  const result = reconcileCanvasPatchAutosavePending({
    authoritativeSnapshot: 'A',
    current: pending({ snapshot: 'A', baseSnapshot: 'wrong', baseRevision: 99 }),
    pending: pending({
      snapshot: 'L',
      baseSnapshot: 'A',
      baseRevision: 7,
      conflicted: true,
      conflicts,
    }),
  });

  assert.equal(result.cancelTimer, true);
  assert.equal(result.shouldReturn, true);
  assert.equal(result.pending?.snapshot, 'A');
  assert.equal(result.pending?.baseSnapshot, 'A');
  assert.equal(result.pending?.baseRevision, 7);
  assert.equal(result.pending?.conflicted, true);
  assert.deepEqual(result.pending?.conflicts, conflicts);
});

test('successful in-flight L save rebases a later A state on server L and schedules the compensating CAS', async () => {
  const requestPending = pending({ snapshot: 'L', baseSnapshot: 'A', baseRevision: 7 });
  let releasePut!: (revision: number) => void;
  const put = new Promise<number>((resolve) => { releasePut = resolve; });
  let generation = 1;
  let current = requestPending;
  let latestPending: CanvasPatchPendingEnvelope | null = requestPending;
  const completion = (async () => {
    const savedRevision = await put;
    return reconcileCanvasPatchAutosaveResponse({
      outcome: 'success',
      savedRevision,
      token: { generation: 1, snapshot: 'L', pendingIdentity: requestPending },
      currentGeneration: generation,
      current,
      pending: latestPending,
      active: true,
    });
  })();

  generation = 2;
  current = pending({ snapshot: 'A' });
  latestPending = null;
  releasePut(8);
  const result = await completion;

  assert.equal(result.acceptedSnapshot, 'L');
  assert.equal(result.acceptedRevision, 8);
  assert.equal(result.tokenMatches, false);
  assert.equal(result.currentSnapshotMatches, false);
  assert.equal(result.pendingIdentityMatches, false);
  assert.equal(result.pending?.snapshot, 'A');
  assert.equal(result.pending?.baseSnapshot, 'L');
  assert.equal(result.pending?.baseRevision, 8);
  assert.equal(result.pending?.conflicted, false);
  assert.equal(result.shouldScheduleCas, true);
});

test('409 from in-flight L save rebuilds conflict provenance from current A after pending was cleared', async () => {
  const requestPending = pending({ snapshot: 'L', baseSnapshot: 'A', baseRevision: 7 });
  let rejectPut!: (reason: Error) => void;
  const put = new Promise<never>((_resolve, reject) => { rejectPut = reject; });
  let generation = 1;
  let current = requestPending;
  let latestPending: CanvasPatchPendingEnvelope | null = requestPending;
  const completion = (async () => {
    try {
      await put;
      assert.fail('PUT should reject');
    } catch {
      return reconcileCanvasPatchAutosaveResponse({
        outcome: 'conflict',
        token: { generation: 1, snapshot: 'L', pendingIdentity: requestPending },
        currentGeneration: generation,
        current,
        pending: latestPending,
        active: true,
      });
    }
  })();

  generation = 2;
  current = pending({ snapshot: 'A' });
  latestPending = null;
  rejectPut(new Error('409'));
  const result = await completion;

  assert.equal(result.acceptedSnapshot, null);
  assert.equal(result.acceptedRevision, null);
  assert.equal(result.tokenMatches, false);
  assert.equal(result.currentSnapshotMatches, false);
  assert.equal(result.pendingIdentityMatches, false);
  assert.equal(result.pending?.snapshot, 'A');
  assert.equal(result.pending?.baseSnapshot, 'A');
  assert.equal(result.pending?.baseRevision, 7);
  assert.equal(result.pending?.conflicted, true);
  assert.deepEqual(result.pending?.conflicts, [{ kind: 'same-field', path: 'revision' }]);
  assert.equal(result.shouldScheduleCas, false);
});

test('background node.patch rebase survives a later stale PUT 409 and schedules compensating persistence', () => {
  const baseNode = {
    id: 'story-1',
    data: { prompt: 'old prompt', status: 'running' },
  };
  const locallyEditedNode = {
    id: 'story-1',
    data: { prompt: 'edited while running', status: 'running' },
  };
  const authoritativeNodePatch = {
    id: 'story-1',
    data: { prompt: 'old prompt', status: 'completed', output: 'durable result' },
  };
  const merged = mergeCanvasPatchValueWithConflicts(
    baseNode,
    locallyEditedNode,
    authoritativeNodePatch,
    'nodes[story-1]',
  );
  assert.deepEqual(merged.conflicts, []);

  const requestPending = pending({
    snapshot: JSON.stringify(locallyEditedNode),
    baseSnapshot: JSON.stringify(baseNode),
    baseRevision: 1,
  });
  const rebasedPending = pending({
    snapshot: JSON.stringify(merged.value),
    baseSnapshot: JSON.stringify(authoritativeNodePatch),
    baseRevision: 2,
  });
  const result = reconcileCanvasPatchAutosaveResponse({
    outcome: 'conflict',
    token: { generation: 1, snapshot: requestPending.snapshot, pendingIdentity: requestPending },
    currentGeneration: 2,
    current: rebasedPending,
    pending: rebasedPending,
    active: true,
  });

  const durable = JSON.parse(result.pending!.snapshot);
  assert.equal(durable.data.prompt, 'edited while running');
  assert.equal(durable.data.status, 'completed');
  assert.equal(durable.data.output, 'durable result');
  assert.equal(result.pending?.baseSnapshot, JSON.stringify(authoritativeNodePatch));
  assert.equal(result.pending?.baseRevision, 2);
  assert.equal(result.pending?.conflicted, false);
  assert.deepEqual(result.pending?.conflicts, []);
  assert.equal(result.shouldScheduleCas, true);
});

test('three-way value merge reports same-field and both delete/edit directions without dropping local intent', () => {
  const sameField = mergeCanvasPatchValueWithConflicts(
    { prompt: 'base' },
    { prompt: 'local' },
    { prompt: 'patch' },
    'node[n1].data',
  );
  assert.deepEqual(sameField.value, { prompt: 'local' });
  assert.deepEqual(sameField.conflicts.map((item) => item.kind), ['same-field']);

  const patchDeletesEditedLocal = mergeCanvasPatchValueWithConflicts(
    { id: 'n1', data: { prompt: 'base' } },
    { id: 'n1', data: { prompt: 'local' } },
    undefined,
    'nodes[n1]',
  );
  assert.deepEqual(patchDeletesEditedLocal.value, { id: 'n1', data: { prompt: 'local' } });
  assert.equal(patchDeletesEditedLocal.conflicts[0]?.kind, 'edit-delete');

  const localDeletesPatched = mergeCanvasPatchValueWithConflicts(
    { id: 'n1', data: { prompt: 'base' } },
    undefined,
    { id: 'n1', data: { prompt: 'patch' } },
    'nodes[n1]',
  );
  assert.equal(localDeletesPatched.value, undefined);
  assert.equal(localDeletesPatched.conflicts[0]?.kind, 'delete-edit');
});

test('graph merge preserves a later local edge against a Patch node deletion and never emits dangling edges', () => {
  const result = mergeCanvasPatchGraph<GraphNode, GraphEdge>({
    baseNodes: [{ id: 'n1' }, { id: 'n2' }],
    localNodes: [{ id: 'n1' }, { id: 'n2' }],
    authoritativeNodes: [{ id: 'n2' }],
    baseEdges: [],
    localEdges: [{ id: 'e1', source: 'n1', target: 'n2' }],
    authoritativeEdges: [],
  });

  assert.ok(result.conflicts.some((item) => item.kind === 'edge-delete-node'));
  assert.ok(result.nodes.some((node) => node.id === 'n1'), 'local edge intent resurrects its locally known endpoint');
  const nodeIds = new Set(result.nodes.map((node) => node.id));
  assert.ok(result.edges.every((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target)));
});

test('synchronous mutation tracker exposes same-batch updates and advances a shared epoch', () => {
  const first = advanceCanvasPatchMutation({ value: [{ id: 'n1' }], epoch: 3 }, (nodes) => [
    ...nodes,
    { id: 'n2' },
  ]);
  const second = advanceCanvasPatchMutation(first, (nodes) => nodes.map((node) => (
    node.id === 'n2' ? { ...node, changed: true } : node
  )));

  assert.equal(first.epoch, 4);
  assert.equal(second.epoch, 5);
  assert.deepEqual(second.value[1], { id: 'n2', changed: true });
  assert.equal(advanceCanvasPatchMutation(second, second.value).epoch, 5);
});

test('Patch history barrier makes generic undo stop at the audited Patch boundary', () => {
  const before = { nodes: [{ id: 'before', position: { x: 0, y: 0 }, data: {} }], edges: [] };
  const patched = { nodes: [{ id: 'patched', position: { x: 0, y: 0 }, data: {} }], edges: [] };
  const later = { nodes: [{ id: 'later', position: { x: 0, y: 0 }, data: {} }], edges: [] };

  let history = createCanvasHistoryState(before);
  history = captureCanvasHistoryState(history, patched);
  const barrier = canvasPatchHistoryBarrier(patched, 'patch-1');
  assert.equal(barrier.mode, 'reset');
  history = createCanvasHistoryState(barrier.snapshot);
  history = captureCanvasHistoryState(history, later);
  history = undoCanvasHistoryState(history);
  assert.equal(history.present?.nodes[0]?.id, 'patched');
  const blocked = undoCanvasHistoryState(history);
  assert.equal(blocked, history, 'generic undo cannot cross the Patch boundary');
  assert.match(barrier.guidance, /我的 Patch/);
});

test('apply/revert single-flight rejects a duplicate in one scope and tab changes invalidate scope', () => {
  const doctorScope = canvasPatchScopeKey('project-1', 'canvas-1', true, 'doctor');
  const runsScope = canvasPatchScopeKey('project-1', 'canvas-1', true, 'runs');
  assert.notEqual(doctorScope, runsScope);

  const first = beginCanvasPatchSingleFlight(null, doctorScope, 1);
  assert.equal(first.accepted, true);
  const duplicate = beginCanvasPatchSingleFlight(first.flight, doctorScope, 2);
  assert.equal(duplicate.accepted, false);
  const otherTab = beginCanvasPatchSingleFlight(first.flight, runsScope, 3);
  assert.equal(otherTab.accepted, true);
  assert.equal(endCanvasPatchSingleFlight(otherTab.flight, first.flight), otherTab.flight);
  assert.equal(endCanvasPatchSingleFlight(otherTab.flight, otherTab.flight), null);
});
