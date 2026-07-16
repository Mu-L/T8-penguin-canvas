import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const canvasSource = readFileSync(new URL('../src/components/Canvas.tsx', import.meta.url), 'utf8');
const workbenchSource = readFileSync(new URL('../src/components/ProjectWorkbench.tsx', import.meta.url), 'utf8');

function callbackSource(source: string, fileName: string, callbackName: string) {
  const parsed = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let result: string | null = null;
  const visit = (node: ts.Node) => {
    if (result) return;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === callbackName) {
      const initializer = node.initializer;
      const callback = initializer && ts.isCallExpression(initializer)
        ? initializer.arguments[0]
        : initializer;
      if (callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) {
        result = callback.getText(parsed);
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  assert.ok(result, `${callbackName} must remain an inspectable function boundary in ${fileName}`);
  return result;
}

function between(source: string, start: string, end: string) {
  const startIndex = source.indexOf(start);
  assert.notEqual(startIndex, -1, `missing start marker: ${start}`);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(endIndex, -1, `missing end marker after ${start}: ${end}`);
  return source.slice(startIndex, endIndex);
}

function assertOrdered(source: string, labels: Array<[label: string, pattern: string | RegExp]>) {
  let cursor = 0;
  for (const [label, pattern] of labels) {
    const remaining = source.slice(cursor);
    const relativeIndex = typeof pattern === 'string'
      ? remaining.indexOf(pattern)
      : remaining.search(pattern);
    assert.notEqual(relativeIndex, -1, `${label} must occur after the preceding gate`);
    cursor += relativeIndex + 1;
  }
}

test('Canvas authorizes the exact preview before atomic RunIntent claim, Run persistence, or Provider execution', () => {
  const authorize = callbackSource(canvasSource, 'Canvas.tsx', 'authorizeRunNodes');
  const run = callbackSource(canvasSource, 'Canvas.tsx', 'runNodesByOrder');

  assert.match(authorize, /authorizeRunPreflight\(\{[\s\S]*snapshot,[\s\S]*prepare:[\s\S]*captureCurrent:[\s\S]*present:[\s\S]*revalidate:/);
  assert.match(authorize, /return authorization\.authorized && authorizedScope\?\.coverageComplete/);
  assert.doesNotMatch(authorize, /api\.createProjectRun\(|\btriggerRun\(|setIsRunning\(true\)|beforeRunPersistence/,
    'read-only preflight must not persist, accept, or execute anything');

  assertOrdered(run, [
    ['empty execution scope returns 0', 'if (order.length === 0) return 0;'],
    ['preflight is awaited', /const authorizedScope = await authorizeRunNodes\(/],
    ['blocked, cancelled, or stale preflight returns -1', 'if (!authorizedScope) return -1;'],
    ['post-confirmation identity is captured', 'const persistenceSnapshot = captureRunPreflightSnapshot();'],
    ['the last identity/revision/graph guard runs before persistence', /if \(!isSameRunPreflightExecutionSnapshot\(/],
    ['the durable Run and pending RunIntent claim enter through one API call', 'const run = await api.createProjectRun({'],
    ['the execution UI becomes active', 'setIsRunning(true);'],
    ['the Provider-facing run bus is triggered', 'triggerRun(id,'],
    ['a successful execution reports its positive node count', 'return order.length;'],
  ]);
  assert.equal(run.match(/api\.createProjectRun\(/g)?.length, 1);
  assert.equal(run.match(/setIsRunning\(true\)/g)?.length, 1);
  assert.equal(run.match(/\btriggerRun\(id,/g)?.length, 1);
});

test('confirmation re-fetches host capability, asset, and policy state instead of reusing cached diagnostics', () => {
  const authorize = callbackSource(canvasSource, 'Canvas.tsx', 'authorizeRunNodes');
  const execution = readFileSync(new URL('../src/utils/runPreflightExecution.ts', import.meta.url), 'utf8');

  assert.match(authorize, /const preparePreview = async \(\) => \{/);
  assert.match(authorize, /api\.getSettings\(\{ signal: controller\.signal \}\)/);
  assert.match(authorize, /api\.getCollaborationExecutionPolicy\(snapshot\.projectId, \{\s*signal: controller\.signal,\s*excludeIntentId: options\.runIntentSnapshot\?\.id,\s*\}\)/);
  assert.match(authorize, /api\.getProjectAsset\(assetId, \{ signal: controller\.signal \}\)/);
  assert.match(authorize, /createRunPreflightHostContextDigest\(\{[\s\S]*settings,[\s\S]*assetIds,[\s\S]*assetRecords,[\s\S]*policy,[\s\S]*runIntent: options\.runIntentSnapshot/);
  assert.match(authorize, /hostContextDigest,/,
    'the exact safe host-state digest must be part of each presented preview');
  assert.match(authorize, /prepare: preparePreview,[\s\S]*revalidate: preparePreview/,
    'the same fresh-context loader must run before presentation and after confirmation');
  assert.match(execution, /const finalPreview = await input\.revalidate\(preview\)/);
  assert.match(execution, /if \(input\.signal\.aborted\)[\s\S]*isSameRunPreflightExecutionSnapshot\(input\.snapshot, input\.captureCurrent\(\)\)/,
    'an abort or graph change during the asynchronous refresh must fail closed');
});

test('all ordinary Canvas run entries declare the all, group, or single action scope explicitly', () => {
  const runAll = callbackSource(canvasSource, 'Canvas.tsx', 'handleRunAll');
  const runGroup = callbackSource(canvasSource, 'Canvas.tsx', 'handleRunGroup');
  const nodeRequest = callbackSource(canvasSource, 'Canvas.tsx', 'handleCanvasNodeRunRequest');

  assert.match(runAll, /runNodesByOrder\(nodes, edges, \{ actionKind: 'run-all' \}\)/);
  assert.match(runGroup, /actionKind: options\.actionKind \|\| \(executable\.length === 1 \? 'run-single' : 'run-group'\)/);
  assert.match(nodeRequest, /handleRunGroup\(\[nodeId\], \{[\s\S]*actionKind: 'run-single',[\s\S]*requestId/);
  assert.match(nodeRequest, /const requestId = String\(detail\?\.requestId \|\| ''\)\.trim\(\)/);
  assert.doesNotMatch(`${runAll}\n${runGroup}\n${nodeRequest}`, /evidenceRefs:/,
    'fresh runs must not attach historical evidence');
});

test('single and group preflight bind the direct input context while exact plans stay exact', () => {
  const authorize = callbackSource(canvasSource, 'Canvas.tsx', 'authorizeRunNodes');
  const run = callbackSource(canvasSource, 'Canvas.tsx', 'runNodesByOrder');
  const group = callbackSource(canvasSource, 'Canvas.tsx', 'handleRunGroup');
  const retry = callbackSource(canvasSource, 'Canvas.tsx', 'handleRetryProjectRun');
  const intent = callbackSource(canvasSource, 'Canvas.tsx', 'handleAcceptRunIntent');

  assert.match(authorize, /buildPossibleDerivedExecutionScope\(\{[\s\S]*nodes: preflightNodes,[\s\S]*edges: preflightEdges,[\s\S]*executionNodeIds: selectedNodeIds,[\s\S]*requestId: options\.requestId/);
  assert.match(authorize, /buildRunPreflightDiagnosticScope\(\{[\s\S]*nodes: derivedScope\.nodes,[\s\S]*edges: derivedScope\.edges,[\s\S]*executionNodeIds: derivedScope\.requiredAuthorizationNodeIds,[\s\S]*mode: 'exact-plan'/);
  assert.match(authorize, /collectRunPreflightAssetIds\(diagnosticScope\.nodes\)/,
    'consumed upstream assets must be checked');
  assert.match(authorize, /prepareRunAction\(\{[\s\S]*nodes: diagnosticScope\.nodes,[\s\S]*edges: diagnosticScope\.edges/,
    'the confirmed executionGraphDigest must bind consumed upstream data and inbound edges');
  assert.match(run, /options\.preflightContextNodes \|\| plannedSubgraph\.nodes/);
  assert.match(run, /options\.preflightContextEdges \|\| plannedSubgraph\.edges/);
  assert.match(group, /preflightContextNodes: options\.preflightContextNodes \|\| nodes/);
  assert.match(group, /preflightContextEdges: options\.preflightContextEdges \|\| edges/);
  assert.match(group, /preflightScopeMode: options\.preflightScopeMode \|\| 'selection-input-context'/);
  assert.match(retry, /if \(mode === 'full-current'\)[\s\S]*preflightContextNodes: nodes,[\s\S]*preflightContextEdges: edges,[\s\S]*preflightScopeMode: 'selection-input-context'/);
  assert.match(intent, /preflightContextNodes: requestedIds\.length \? currentNodes : planned\.nodes/);
  assert.match(intent, /preflightScopeMode: requestedIds\.length \? 'selection-input-context' : 'exact-plan'/);
});

test('Run replay and retry paths bind exactly one Run-level evidence reference', () => {
  const retryRun = callbackSource(canvasSource, 'Canvas.tsx', 'handleRetryProjectRun');
  const current = between(retryRun, "if (mode === 'full-current')", 'const failedAndDownstream');
  const original = retryRun.slice(retryRun.indexOf('const failedAndDownstream'));

  assert.match(current, /actionKind: 'retry-run',\s*evidenceRefs: \[\{ runId: run\.id \}\],/);
  assert.match(original, /actionKind: mode === 'full-original' \? 'replay-run' : 'retry-run',\s*evidenceRefs: \[\{ runId: run\.id \}\],/);
  assert.equal(retryRun.match(/evidenceRefs:\s*\[\{ runId: run\.id \}\]/g)?.length, 2,
    'each Run replay/retry branch must cite only its source Run');
  assert.doesNotMatch(retryRun, /evidenceRefs:[\s\S]{0,100}(?:nodeRunId|attemptId)/,
    'Run-level actions must not silently mix in NodeRun or Attempt evidence');
});

test('subflow and Attempt retries bind their exact Run/NodeRun/Attempt identity level', () => {
  const subflow = callbackSource(canvasSource, 'Canvas.tsx', 'executeSubflowNodeReplay');
  const attempt = callbackSource(canvasSource, 'Canvas.tsx', 'handleRetryProjectRunAttempt');

  assert.match(subflow, /actionKind: sourceAttempt \? 'retry-attempt' : 'retry-subflow'/);
  assert.match(subflow, /evidenceRefs: \[sourceAttempt\s*\? \{ runId: run\.id, nodeRunId: nodeRun\.id, attemptId: sourceAttempt\.id \}\s*: \{ runId: run\.id, nodeRunId: nodeRun\.id \}\]/);
  assert.match(attempt, /if \(nodeRun\.parentNodeRunId\) return executeSubflowNodeReplay\(run, nodeRun, attempt\)/,
    'nested Attempt retries must use the subflow hierarchy path');
  assert.match(attempt, /actionKind: 'retry-attempt',\s*evidenceRefs: \[\{ runId: run\.id, nodeRunId: nodeRun\.id, attemptId: attempt\.id \}\],/);
});

test('RunIntent stays pending through confirmation and is claimed only by atomic Run creation', () => {
  const run = callbackSource(canvasSource, 'Canvas.tsx', 'runNodesByOrder');
  const accept = callbackSource(canvasSource, 'Canvas.tsx', 'handleAcceptRunIntent');

  assert.match(accept, /actionKind: 'run-intent'/);
  assert.match(accept, /requestId: intent\.id/);
  assert.match(accept, /expectedRevision: intent\.canvasRevision/);
  assert.match(accept, /runIntentSnapshot: intent/);
  assert.doesNotMatch(accept, /status: 'accepted'|beforeRunPersistence|accepted\s*=/,
    'Canvas must not create an accepted-but-unclaimed crash window');
  assert.match(run, /runIntentId: options\.runIntentId \|\| null/);
  assert.match(run, /runIntentRecovery: options\.runIntentSnapshot\?\.status === 'accepted' \? 'legacy-accepted' : null/);

  assertOrdered(run, [
    ['confirmation and final preview revalidation finish', /const authorizedScope = await authorizeRunNodes\(/],
    ['non-authorized intent remains pending', 'if (!authorizedScope) return -1;'],
    ['a second TOCTOU guard runs before Run creation', /if \(!isSameRunPreflightExecutionSnapshot\(/],
    ['one Run creation request also claims the pending intent', 'const run = await api.createProjectRun({'],
  ]);
  assert.equal(run.match(/api\.createProjectRun\(/g)?.length, 1);
});

test('Canvas and Workbench preserve -1 cancelled, 0 unavailable, and positive success semantics', () => {
  const run = callbackSource(canvasSource, 'Canvas.tsx', 'runNodesByOrder');
  const accept = callbackSource(canvasSource, 'Canvas.tsx', 'handleAcceptRunIntent');
  assert.match(run, /if \(order\.length === 0\) return 0;/);
  assert.match(run, /if \(!authorizedScope\) return -1;/);
  assert.match(run, /return order\.length;/);
  assertOrdered(accept, [
    ['preflight cancellation returns without mutating intent status', 'if (count < 0) return false;'],
    ['an empty executable scope becomes stale', 'if (count === 0) {'],
    ['only a positive count is successful', 'return true;'],
  ]);

  for (const callbackName of ['retryRun', 'retrySubflowNodeRun', 'retryRunAttempt']) {
    const callback = callbackSource(workbenchSource, 'ProjectWorkbench.tsx', callbackName);
    assertOrdered(callback, [
      [`${callbackName} ignores a cancelled preflight`, 'if (count < 0) return;'],
      [`${callbackName} reports a genuinely unavailable graph`, 'if (count === 0)'],
      [`${callbackName} announces only a positive execution`, /setMessage\(/],
      [`${callbackName} refreshes only after a positive execution`, 'await loadRuns();'],
    ]);
  }
});

test('one CAS gate spans preflight through terminal persistence and graph changes after confirmation stop Provider dispatch', () => {
  const run = callbackSource(canvasSource, 'Canvas.tsx', 'runNodesByOrder');
  assertOrdered(run, [
    ['a synchronous gate rejects overlap', 'if (runExecutionGateRef.current) {'],
    ['the gate is claimed before any await', "runExecutionGateRef.current = executionGateToken;"],
    ['preflight happens under the gate', /const authorizedScope = await authorizeRunNodes\(/],
    ['Run persistence happens under the same gate', 'const run = await api.createProjectRun({'],
    ['the graph is rechecked after Run creation', /runId = run\.id;[\s\S]*if \(!isSameRunPreflightExecutionSnapshot\(persistenceSnapshot, captureRunPreflightSnapshot\(\)\)\)/],
    ['Provider tokens are issued only after the rechecks', 'executionToken = triggerRun(id,'],
    ['terminal Run persistence precedes gate release', 'await api.updateProjectRun(runId, {'],
    ['the CAS gate is released last', 'runExecutionGateRef.current = null;'],
  ]);
  assert.match(run, /await api\.updateProjectRun\(run\.id,[\s\S]*if \(!isSameRunPreflightExecutionSnapshot\(persistenceSnapshot, captureRunPreflightSnapshot\(\)\)\)/,
    'a delayed transition to running must also recheck the exact graph');
  assert.match(run, /if \(runId && options\.prepareRunExecution\)[\s\S]*if \(!isSameRunPreflightExecutionSnapshot\(persistenceSnapshot, captureRunPreflightSnapshot\(\)\)\)/,
    'prepared replay hierarchy persistence must not create an unchecked execution window');
});
