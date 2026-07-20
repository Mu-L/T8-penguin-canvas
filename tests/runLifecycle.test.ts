import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  createRunNodeLifecycleController,
  executeAfterRunLifecycleBarrier,
  resolveRunExecutionDisposition,
} from '../src/utils/runLifecycle.ts';

test('execution disposition distinguishes active, cancelled, superseded and released work', () => {
  assert.equal(resolveRunExecutionDisposition('token-a', 'token-a', false), 'active');
  assert.equal(resolveRunExecutionDisposition('token-b', 'token-a', false), 'superseded');
  assert.equal(resolveRunExecutionDisposition(undefined, 'token-a', false), 'released');
  assert.equal(resolveRunExecutionDisposition('token-a', 'token-a', true), 'stopped');
});

test('lifecycle reporter serializes node and provider events with stable identity', async () => {
  const writes: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const controller = createRunNodeLifecycleController({
    runContext: {
      contextId: 'context-a',
      runId: 'run-a',
      projectId: 'project-a',
      canvasId: 'canvas-a',
      canvasRevision: 2,
      mode: 'batch',
      plannedNodeIds: ['node-a'],
      createdAt: 1,
    },
    executionToken: 'token-a',
    executionEvidence: () => ({ nodeRunId: 'node-run-a', attemptId: 'attempt-a' }),
    basePayload: { nodeId: 'node-a', contextId: 'context-a' },
    sink: {
      write: async (type, payload) => {
        if (type === 'node.progress') await Promise.resolve();
        writes.push({ type, payload });
      },
    },
  });

  void controller.reporter.progress({ percent: 25 });
  void controller.reporter.polling({ pollCount: 2 });
  void controller.reporter.providerRequest({ provider: 'seedance-nz', model: 'wan-2.7-spicy-i2v' });
  void controller.reporter.providerSubmitted({ upstreamTaskId: 'task-a', httpStatus: 202 });
  void controller.reporter.providerResponse({ upstreamTaskId: 'task-a', httpStatus: 200 });
  void controller.reporter.providerUsage({ credits: 1 });
  await controller.reporter.output({ outputCount: 1 });
  await controller.flush();

  assert.deepEqual(writes.map((item) => item.type), [
    'node.progress',
    'node.polling',
    'provider.request',
    'provider.submitted',
    'provider.response',
    'provider.usage',
    'node.output',
  ]);
  assert.deepEqual(writes.map((item) => item.payload.sequence), [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(writes.every((item) => item.payload.executionToken === 'token-a'), true);
  assert.equal(writes.every((item) => item.payload.contextId === 'context-a'), true);
  assert.equal(controller.outputEmitted(), true);
  assert.equal(controller.reporter.runContext?.runId, 'run-a');
  assert.equal(controller.reporter.nodeRunId, 'node-run-a');
  assert.equal(controller.reporter.attemptId, 'attempt-a');
});

test('failed initial lifecycle persistence invokes the expensive callback zero times', async () => {
  let callbackCalls = 0;
  let persistenceCalls = 0;
  const controller = createRunNodeLifecycleController({
    executionToken: 'token-initial-persistence-failure',
    sink: {
      write: async () => {
        persistenceCalls += 1;
        throw new Error('initial lifecycle write failed');
      },
    },
  });
  await assert.rejects(
    executeAfterRunLifecycleBarrier(
      async () => {
        await controller.reporter.progress({ phase: 'executing', progress: 0 });
      },
      async () => { callbackCalls += 1; },
    ),
    /initial lifecycle write failed/,
  );
  assert.equal(persistenceCalls, 1);
  assert.equal(callbackCalls, 0);
});

test('output persistence fails closed and cannot mark output as emitted', async () => {
  const writes: string[] = [];
  const failure = new Error('authoritative artifact write failed');
  const controller = createRunNodeLifecycleController({
    executionToken: 'token-output-failure',
    sink: {
      write: async (type) => {
        writes.push(type);
        if (type === 'node.output') throw failure;
      },
    },
  });

  await assert.rejects(
    controller.reporter.output({ outputCount: 1 }),
    /authoritative artifact write failed/,
  );
  assert.equal(controller.outputEmitted(), false);

  // The serialized queue remains usable for terminal evidence, while flush
  // keeps reporting the first authoritative persistence failure.
  await controller.reporter.providerResponse({ status: 'failed' });
  await assert.rejects(controller.flush(), /authoritative artifact write failed/);
  assert.deepEqual(writes, ['node.output', 'provider.response']);
});

test('topology entry and single-node action bar share the persisted RunContext path', () => {
  const canvas = readFileSync(new URL('../src/components/Canvas.tsx', import.meta.url), 'utf8');
  const actionBar = readFileSync(new URL('../src/components/NodeActionBar.tsx', import.meta.url), 'utf8');
  const hook = readFileSync(new URL('../src/hooks/useRunTrigger.ts', import.meta.url), 'utf8');

  assert.match(canvas, /status: 'queued'/);
  assert.match(canvas, /setActiveRunContext\(runContext\)/);
  assert.match(canvas, /status: 'running',[\s\S]*runContextId: runContext\.contextId/);
  assert.match(canvas, /await cancelPersistenceRef\.current/);
  assert.match(canvas, /<NodeActionBar[\s\S]*onRunNode=\{\(nodeId\) => handleRunGroup\(\[nodeId\]\)\}/);
  assert.match(actionBar, /EXECUTABLE_NODE_TYPES.*executableNodeTypes/);
  assert.match(actionBar, /void onRunNode\(selectedExe\.id\)/);
  assert.doesNotMatch(actionBar, /const EXECUTABLE_NODE_TYPES = new Set/);

  assert.match(hook, /createRunNodeLifecycleController/);
  assert.match(hook, /extractRunProviderTrace/);
  assert.match(hook, /providerTraceAttemptPatch/);
  assert.match(hook, /collectRunOutputAssets/);
  assert.match(hook, /persistProjectRunOutputAssets/);
  assert.match(hook, /!executionCallbackStarted[\s\S]*type === 'node\.output'[\s\S]*type === 'provider\.request'/);
  assert.match(hook, /executeAfterRunLifecycleBarrier/);
  assert.match(hook, /if \(status === 'succeeded'\) throw lifecyclePersistenceError/);
  assert.match(hook, /providerRequest/);
  assert.match(hook, /providerSubmitted/);
  assert.match(hook, /providerResponse/);
  assert.match(hook, /providerUsage/);
  assert.match(hook, /status: 'queued'/);
  assert.match(hook, /status: 'running'/);
  assert.match(hook, /reporter\.progress\(\{ phase: 'executing', progress: 0 \}\)/);
  assert.match(hook, /reporter\.progress\(\{ phase: 'completed', progress: 100 \}\)/);
  assert.match(hook, /collectRunOutputAssets\(latestNodeData\)[\s\S]*reporter\.output\(\{ status: 'succeeded', outputCount: assets\.length, assets \}\)/);
  assert.match(hook, /latestStatus === 'error'.*latestStatus === 'failed'.*latestStatus === 'failure'/s);
  assert.match(hook, /persistTerminal\('stopped'/);
  assert.match(hook, /finalizeProjectNodeRunAttempt/);
  assert.match(hook, /writeAttempt < 3/);
  assert.doesNotMatch(hook, /failed to persist node terminal state/);
  assert.match(canvas, /await api\.updateProjectRun\(runId/);
  assert.match(canvas, /terminalEvidencePersistenceFailed/);
});

test('every frontend polling provider reports canonical polling events through the lifecycle-aware hook', () => {
  const providerFiles = [
    'ImageNode.tsx',
    'AudioNode.tsx',
    'VideoNode.tsx',
    'SeedanceNode.tsx',
    'RunningHubNode.tsx',
    'RHToolsNode.tsx',
    'FalToolboxNode.tsx',
    'RHToolboxNode.tsx',
    'DirectorStoryboardNode.tsx',
    'GrokOAuthAgentNode.tsx',
  ];

  for (const file of providerFiles) {
    const source = readFileSync(new URL(`../src/components/nodes/${file}`, import.meta.url), 'utf8');
    assert.match(source, /lifecycleAware:\s*true/, `${file} must opt into the lifecycle reporter`);
    assert.match(source, /reporter\?\.polling\(/, `${file} must archive real polling callbacks`);
    assert.match(source, /reporter\?\.providerRequest\(/, `${file} must archive provider request metadata`);
    assert.match(source, /reporter\?\.providerSubmitted\(/, `${file} must archive explicit task or request ids`);
    assert.match(source, /reporter\?\.providerResponse\(/, `${file} must archive terminal provider responses`);
    assert.match(source, /transportHttpStatus/, `${file} must preserve the local transport status without calling it upstream`);
  }
});
