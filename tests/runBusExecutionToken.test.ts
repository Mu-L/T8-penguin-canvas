import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));

function read(rel: string) {
  return readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
}

let runBus: any;
let store: any;

test.before(async () => {
  const result = await build({
    absWorkingDir: projectRoot,
    entryPoints: ['src/stores/runBus.ts'],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    logLevel: 'silent',
  });
  const source = result.outputFiles[0].text;
  runBus = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  store = runBus.useRunBusStore;
});

test.beforeEach(() => {
  runBus.clearRunExecutionBindings();
  store.setState({
    activeRunId: null,
    activeRunContext: null,
    activeNodeRunIds: {},
    activeNodeRunTokens: {},
    currentRunId: null,
    runningIds: [],
    executionTokens: {},
    lastDone: null,
    cancelSeq: 0,
    cancelTargets: [],
    mode: 'idle',
    batchTotal: 0,
    batchDoneCount: 0,
  });
});

function context(runId: string, plannedNodeIds = ['node-a'], requestId = `request-${runId}`) {
  return {
    contextId: `context-${runId}`,
    runId,
    projectId: 'project-run-context',
    canvasId: 'canvas-run-context',
    canvasRevision: 7,
    mode: 'batch',
    plannedNodeIds,
    authorizedNodeIds: [...plannedNodeIds],
    parentRunId: null,
    replayMode: null,
    replaySourceRunId: null,
    requestId,
    createdAt: 100,
  };
}

test('same node retrigger gets a unique token and stale completion cannot finish the new task', () => {
  const firstToken = store.getState().triggerRun('same-node');
  const secondToken = store.getState().triggerRun('same-node');

  assert.notEqual(firstToken, secondToken);
  assert.equal(store.getState().executionTokens['same-node'], secondToken);
  assert.deepEqual(store.getState().runningIds, ['same-node']);

  assert.equal(store.getState().markDone('same-node', firstToken, true), false);
  assert.equal(store.getState().lastDone, null);
  assert.equal(store.getState().executionTokens['same-node'], secondToken);
  assert.deepEqual(store.getState().runningIds, ['same-node']);

  assert.equal(store.getState().markDone('same-node', secondToken, true), true);
  assert.equal(store.getState().lastDone.executionToken, secondToken);
  assert.equal(store.getState().executionTokens['same-node'], undefined);
  assert.deepEqual(store.getState().runningIds, []);
});

test('completion from a stopped task is ignored while a fresh task with the same node id is running', () => {
  const stoppedToken = store.getState().triggerRun('video-node');
  store.getState().cancelAll();
  const freshToken = store.getState().triggerRun('video-node');

  assert.notEqual(stoppedToken, freshToken);
  assert.equal(store.getState().markDone('video-node', stoppedToken, false, 'late stop result'), false);
  assert.equal(store.getState().lastDone, null);
  assert.equal(store.getState().executionTokens['video-node'], freshToken);
  assert.deepEqual(store.getState().runningIds, ['video-node']);

  assert.equal(store.getState().markDone('video-node', freshToken, true), true);
  assert.equal(runBus.matchesRunCompletion(store.getState().lastDone, 'video-node', freshToken), true);
});

test('late NodeRun registration and cleanup cannot replace or clear the current token mapping', () => {
  const oldToken = store.getState().triggerRun('subflow-node');
  store.getState().setActiveNodeRun('subflow-node', 'node-run-old', oldToken);
  assert.equal(store.getState().activeNodeRunIds['subflow-node'], 'node-run-old');

  const currentToken = store.getState().triggerRun('subflow-node');
  assert.equal(store.getState().activeNodeRunIds['subflow-node'], undefined);
  store.getState().setActiveNodeRun('subflow-node', 'node-run-late-old', oldToken);
  assert.equal(store.getState().activeNodeRunIds['subflow-node'], undefined);

  store.getState().setActiveNodeRun('subflow-node', 'node-run-current', currentToken);
  store.getState().setActiveNodeRun('subflow-node', undefined, oldToken);
  assert.equal(store.getState().activeNodeRunIds['subflow-node'], 'node-run-current');
  assert.equal(store.getState().activeNodeRunTokens['subflow-node'], currentToken);

  store.getState().setActiveNodeRun('subflow-node', undefined, currentToken);
  assert.equal(store.getState().activeNodeRunIds['subflow-node'], undefined);
});

test('batch trigger returns one unique token per node and completes nodes independently', () => {
  const tokens = store.getState().triggerRunMany(['image-a', 'image-b', 'image-a'], 'batch');
  assert.deepEqual(Object.keys(tokens).sort(), ['image-a', 'image-b']);
  assert.notEqual(tokens['image-a'], tokens['image-b']);
  assert.equal(store.getState().executionTokens['image-a'], tokens['image-a']);
  assert.equal(store.getState().executionTokens['image-b'], tokens['image-b']);

  assert.equal(store.getState().markDone('image-a', tokens['image-a'], true), true);
  assert.deepEqual(store.getState().runningIds, ['image-b']);
  assert.equal(store.getState().executionTokens['image-b'], tokens['image-b']);
  assert.equal(store.getState().markDone('image-a', tokens['image-a'], true), false);
  assert.equal(store.getState().lastDone.id, 'image-a');

  assert.equal(store.getState().markDone('image-b', tokens['image-b'], false, 'provider failed'), true);
  assert.equal(store.getState().lastDone.id, 'image-b');
  assert.equal(store.getState().lastDone.error, 'provider failed');
});

test('execution tokens keep immutable RunContext and node identity snapshots across retriggers', () => {
  const unregister = runBus.registerRunNodeExecutionContexts({
    'node-a': {
      subflowPath: ['outer', 'inner'],
      originalNodeId: 'leaf-a',
      runNodeId: 'outer::inner::leaf-a',
      definitionId: 'flow-a',
      definitionVersion: 3,
      inputSnapshot: { prompt: 'old prompt' },
    },
  });
  const firstContext = context('run-old');
  store.getState().setActiveRunContext(firstContext);
  const oldToken = store.getState().triggerRun('node-a', 'batch');
  const oldBinding = runBus.getRunExecutionBinding('node-a', oldToken);
  assert.equal(oldBinding.runContext.runId, 'run-old');
  assert.equal(oldBinding.runContext.requestId, 'request-run-old');
  assert.deepEqual(oldBinding.runContext.plannedNodeIds, ['node-a']);
  assert.deepEqual(oldBinding.nodeContext.subflowPath, ['outer', 'inner']);
  assert.equal(oldBinding.nodeContext.originalNodeId, 'leaf-a');

  firstContext.plannedNodeIds.push('mutated-after-bind');
  firstContext.authorizedNodeIds.push('mutated-after-bind');
  firstContext.requestId = 'mutated-after-bind';
  unregister();
  store.getState().setActiveRunContext(context('run-new'));
  const newToken = store.getState().triggerRun('node-a', 'single');
  assert.equal(runBus.getRunExecutionBinding('node-a', oldToken).runContext.runId, 'run-old');
  assert.equal(runBus.getRunExecutionBinding('node-a', oldToken).runContext.requestId, 'request-run-old');
  assert.deepEqual(runBus.getRunExecutionBinding('node-a', oldToken).runContext.plannedNodeIds, ['node-a']);
  assert.deepEqual(runBus.getRunExecutionBinding('node-a', oldToken).runContext.authorizedNodeIds, ['node-a']);
  assert.equal(runBus.getRunExecutionBinding('node-a', newToken).runContext.runId, 'run-new');
  assert.equal(runBus.getRunExecutionBinding('node-a', newToken).nodeContext, null);

  runBus.releaseRunExecutionBinding('node-a', oldToken);
  assert.equal(runBus.getRunExecutionBinding('node-a', oldToken), null);
});

test('active RunContext refuses execution tokens outside the final preflight allowlist', () => {
  store.getState().setActiveRunContext(context('run-authorized', ['node-a']));
  assert.throws(
    () => store.getState().triggerRun('node-b'),
    /不在最终体检授权范围内/,
  );
  assert.throws(
    () => store.getState().triggerRunMany(['node-a', 'node-b']),
    /不在最终体检授权范围内/,
  );
  assert.deepEqual(store.getState().executionTokens, {});
  const token = store.getState().triggerRun('node-a');
  assert.equal(typeof token, 'string');
});

test('cancelAll awaits registered persistence and late handlers still see cancelled tokens', async () => {
  store.getState().setActiveRunContext(context('run-cancel'));
  const token = store.getState().triggerRun('node-a');
  const calls: string[] = [];
  runBus.registerRunExecutionCancelHandler('node-a', token, async () => {
    await Promise.resolve();
    calls.push('persisted-stopped');
  });
  await store.getState().cancelAll();
  assert.deepEqual(calls, ['persisted-stopped']);
  assert.equal(runBus.isRunExecutionCancelled(token), true);
  assert.equal(runBus.getRunExecutionBinding('node-a', token).runContext.runId, 'run-cancel');

  const lateToken = store.getState().triggerRun('node-a');
  await store.getState().cancelAll();
  runBus.registerRunExecutionCancelHandler('node-a', lateToken, () => calls.push('late-persisted-stopped'));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(calls, ['persisted-stopped', 'late-persisted-stopped']);

  runBus.releaseRunExecutionBinding('node-a', token);
  runBus.releaseRunExecutionBinding('node-a', lateToken);
  assert.equal(runBus.isRunExecutionCancelled(token), false);
  assert.equal(runBus.isRunExecutionCancelled(lateToken), false);
});

test('all run-bus waiters require node id and execution token instead of timestamps', () => {
  const canvas = read('src/components/Canvas.tsx');
  const loop = read('src/components/nodes/LoopNode.tsx');
  const randomRoute = read('src/components/nodes/RandomRouteNode.tsx');
  const subflow = read('src/components/nodes/SubflowNode.tsx');
  const hook = read('src/hooks/useRunTrigger.ts');

  assert.match(canvas, /matchesRunCompletion\(state\.lastDone, id, executionToken\)/);
  assert.match(loop, /matchesRunCompletion\(state\.lastDone, nodeId, executionToken\)/);
  assert.match(randomRoute, /matchesRunCompletion\(state\.lastDone, nodeId, executionToken\)/);
  assert.match(subflow, /matchesRunCompletion\(state\.lastDone, nodeId, executionToken\)/);
  assert.doesNotMatch(`${loop}\n${randomRoute}\n${subflow}`, /lastDone\.ts\s*>=/);

  assert.match(hook, /s\.executionTokens\[nodeId\]/);
  assert.match(hook, /markDone\(nodeId, capturedExecutionToken, true\)/);
  assert.match(hook, /setActiveNodeRun\(nodeId, undefined, capturedExecutionToken\)/);
  assert.match(hook, /getRunExecutionBinding\(nodeId, capturedExecutionToken\)/);
  assert.match(hook, /registerRunExecutionCancelHandler/);
  assert.match(hook, /await persistTerminal\('succeeded'\)/);
});
