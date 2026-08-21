import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
let runTrigger: any;
let runBus: any;

test.before(async () => {
  const result = await build({
    absWorkingDir: projectRoot,
    stdin: {
      contents: [
        "export { containRunTriggerInitializationFailure } from './src/hooks/useRunTrigger.ts';",
        "export { clearRunExecutionBindings, registerRunExecutionCancelHandler, useRunBusStore } from './src/stores/runBus.ts';",
      ].join('\n'),
      resolveDir: projectRoot,
      sourcefile: 'run-trigger-failure-test-entry.ts',
      loader: 'ts',
    },
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    logLevel: 'silent',
  });
  const source = result.outputFiles[0].text;
  const module = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  runTrigger = module;
  runBus = module;
});

test.afterEach(() => {
  runBus.clearRunExecutionBindings();
  runBus.useRunBusStore.setState({
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

test('listener initialization failure persists evidence and always terminates its token', async () => {
  const calls: string[] = [];
  const reports: string[] = [];
  const result = await runTrigger.containRunTriggerInitializationFailure({
    executionNodeId: 'canvas-a::node-a',
    executionToken: 'token-a',
    nodeId: 'node-a',
    runId: 'run-a',
    error: new Error('setup exploded'),
  }, {
    appendRunEvent: async (runId: string, event: { type: string }) => {
      calls.push(`event:${runId}:${event.type}`);
      return {} as never;
    },
    markDone: (_nodeId: string, _token: string, ok: boolean, error?: string) => calls.push(`done:${ok}:${error}`),
    clearActiveNodeRun: () => calls.push('clear-active'),
    releaseBinding: () => calls.push('release-binding'),
    forgetToken: () => calls.push('forget-token'),
    reportError: (message: string) => reports.push(message),
  });

  assert.equal(result.evidencePersisted, true);
  assert.equal(result.message, 'setup exploded');
  assert.deepEqual(calls, [
    'event:run-a:node.initialization_failed',
    'done:false:节点运行初始化失败：setup exploded',
    'clear-active',
    'release-binding',
    'forget-token',
  ]);
  assert.equal(reports.some((message) => message.includes('initialization failed')), true);
});

test('listener containment consumes persistence and cleanup failures instead of rejecting', async () => {
  const reports: string[] = [];
  await assert.doesNotReject(runTrigger.containRunTriggerInitializationFailure({
    executionNodeId: 'canvas-a::node-a',
    executionToken: 'token-a',
    nodeId: 'node-a',
    runId: 'run-a',
    error: new Error('setup exploded'),
  }, {
    appendRunEvent: async () => { throw new Error('evidence offline'); },
    markDone: () => { throw new Error('mark failed'); },
    clearActiveNodeRun: () => { throw new Error('clear failed'); },
    releaseBinding: () => { throw new Error('release failed'); },
    forgetToken: () => { throw new Error('forget failed'); },
    reportError: (message: string) => reports.push(message),
  }));
  assert.equal(reports.some((message) => message.includes('evidence persistence failed')), true);
  assert.equal(reports.some((message) => message.includes('cleanup failed')), true);
});

test('a late cancel-handler rejection is caught and logged without an unhandled rejection', async () => {
  const token = runBus.useRunBusStore.getState().triggerRun('node-a');
  await runBus.useRunBusStore.getState().cancelAll();
  const reports: unknown[][] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => { reports.push(args); };
  try {
    runBus.registerRunExecutionCancelHandler('node-a', token, async () => {
      throw new Error('late terminal persistence failed');
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    console.error = originalError;
  }
  assert.equal(reports.length, 1);
  assert.match(String(reports[0][0]), /late cancel persistence failed/);
});