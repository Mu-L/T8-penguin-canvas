import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const canvasSource = readFileSync(new URL('../src/components/Canvas.tsx', import.meta.url), 'utf8');

function callbackSource(callbackName: string) {
  const parsed = ts.createSourceFile('Canvas.tsx', canvasSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let result: string | null = null;
  const visit = (node: ts.Node) => {
    if (result) return;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === callbackName) {
      const initializer = node.initializer;
      const callback = initializer && ts.isCallExpression(initializer) ? initializer.arguments[0] : initializer;
      if (callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) {
        result = callback.getText(parsed);
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  assert.ok(result, `${callbackName} must remain an inspectable Canvas function boundary`);
  return result;
}

test('Canvas owns secondary Provider actions and runs only the exact stored single-node envelope', () => {
  const listener = callbackSource('handleSecondaryProviderActionRequest');

  assert.match(listener, /validateSecondaryProviderAction\(detail\?\.action\)/);
  assert.match(listener, /secondaryProviderActionFromNodeData\(node\?\.data\)/);
  assert.match(listener, /node\.type !== action\.nodeType/);
  assert.match(listener, /storedAction\?\.requestId !== action\.requestId/);
  assert.match(listener, /storedAction\.digest !== action\.digest/);
  assert.match(listener, /runNodesByOrder\(\[node\], \[\], \{/);
  assert.match(listener, /executionOrder: \[node\.id\]/);
  assert.match(listener, /requestId: action\.requestId/);
  assert.match(listener, /secondaryProviderAction: action/);
  assert.match(listener, /preflightContextNodes: currentNodes/);
  assert.match(listener, /preflightContextEdges: currentEdges/);
  assert.match(listener, /\.finally\(clearPendingAction\)/,
    'cancelled, blocked, failed, and completed actions must not leave a replayable envelope behind');
});

test('final preflight authorization binds secondary action identity into the durable RunContext', () => {
  const run = callbackSource('runNodesByOrder');

  assert.match(run, /validateSecondaryProviderAction\(options\.secondaryProviderAction\)/);
  assert.match(run, /order\.length !== 1/);
  assert.match(run, /order\[0\] !== secondaryProviderAction\.nodeId/);
  assert.match(run, /authorizedNodeIds\.length !== 1/);
  assert.match(run, /authorizedNodeIds\[0\] !== secondaryProviderAction\.nodeId/);
  assert.match(run, /authorizedNode\?\.type !== secondaryProviderAction\.nodeType/);
  assert.match(run, /currentAction\?\.requestId !== secondaryProviderAction\.requestId/);
  assert.match(run, /currentAction\.digest !== secondaryProviderAction\.digest/);

  for (const field of [
    'secondaryProviderActionSchema',
    'secondaryProviderActionId',
    'secondaryProviderActionTarget',
    'secondaryProviderActionDigest',
  ]) {
    assert.ok(run.match(new RegExp(`${field}: secondaryProviderAction\\?\\.` , 'g'))?.length === 3,
      `${field} must be copied to queued summary, immutable RunContext, and terminal summary`);
  }
  assert.match(run, /plannedNodeIds: \[\.\.\.recordedOrder\]/);
  assert.match(run, /authorizedNodeIds,/);
});

test('secondary Provider Runs fail closed instead of falling into ordinary retry or replay paths', () => {
  assert.match(canvasSource, /function isSecondaryProviderActionRun\([\s\S]*secondaryProviderActionId/);
  for (const callbackName of [
    'handleRetryProjectRun',
    'executeSubflowNodeReplay',
    'handleRetryProjectRunAttempt',
  ]) {
    const callback = callbackSource(callbackName);
    assert.match(callback, /isSecondaryProviderActionRun\(run\)/,
      `${callbackName} must reject a stale secondary action before rebuilding a generic RunContext`);
  }
});
