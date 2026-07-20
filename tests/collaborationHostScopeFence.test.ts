import assert from 'node:assert/strict';
import test from 'node:test';
import {
  collaborationHostScopeKey,
  createCollaborationHostScopeFence,
  runCollaborationHostScopedMutation,
} from '../src/utils/collaborationHostScopeFence.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

test('Host scope fence rejects an A mutation that resolves after B became authoritative', async () => {
  const scopeA = collaborationHostScopeKey('project-a', 'canvas-a');
  const scopeB = collaborationHostScopeKey('project-b', 'canvas-b');
  const fence = createCollaborationHostScopeFence(scopeA);
  fence.mount();

  const aResult = deferred<string>();
  const applied: string[] = [];
  const refreshed: string[] = [];
  const errors: string[] = [];
  const settled: string[] = [];
  const tokenA = fence.capture();
  const pendingA = runCollaborationHostScopedMutation({
    fence,
    token: tokenA,
    action: () => aResult.promise,
    onSuccess: (value) => applied.push(value),
    refresh: async (token) => { refreshed.push(token.scopeKey); },
    onError: (error) => errors.push(String(error)),
    onSettled: () => settled.push('a'),
  });

  fence.setScope(scopeB);
  const tokenB = fence.capture();
  const completedB = await runCollaborationHostScopedMutation({
    fence,
    token: tokenB,
    action: async () => 'policy-b',
    onSuccess: (value) => applied.push(value),
    refresh: async (token) => { refreshed.push(token.scopeKey); },
    onError: (error) => errors.push(String(error)),
    onSettled: () => settled.push('b'),
  });

  aResult.resolve('policy-a');
  const completedA = await pendingA;

  assert.deepEqual(completedB, { status: 'applied', value: 'policy-b' });
  assert.deepEqual(completedA, { status: 'stale' });
  assert.deepEqual(applied, ['policy-b']);
  assert.deepEqual(refreshed, [scopeB]);
  assert.deepEqual(errors, []);
  assert.deepEqual(settled, ['b']);
});

test('Host scope key is collision-safe and unmount invalidates captured work', async () => {
  assert.notEqual(
    collaborationHostScopeKey('project:a', 'canvas'),
    collaborationHostScopeKey('project', 'a:canvas'),
  );

  const scope = collaborationHostScopeKey('project-a', 'canvas-a');
  const fence = createCollaborationHostScopeFence(scope);
  fence.mount();
  const token = fence.capture();
  fence.unmount();

  let actionCalled = false;
  const result = await runCollaborationHostScopedMutation({
    fence,
    token,
    action: async () => { actionCalled = true; return 'unexpected'; },
    onSuccess: () => undefined,
    refresh: async () => undefined,
    onError: () => undefined,
    onSettled: () => undefined,
  });
  assert.deepEqual(result, { status: 'stale' });
  assert.equal(actionCalled, false);
});
