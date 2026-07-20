export interface CollaborationHostScopeToken {
  readonly scopeKey: string;
  readonly generation: number;
}

export interface CollaborationHostScopeFence {
  mount(): void;
  unmount(): void;
  setScope(scopeKey: string): void;
  capture(): CollaborationHostScopeToken;
  isCurrent(token: CollaborationHostScopeToken): boolean;
}

export type CollaborationHostScopedMutationResult<T> =
  | { status: 'applied'; value: T }
  | { status: 'failed'; error: unknown }
  | { status: 'stale' };

export function collaborationHostScopeKey(projectId: string, canvasId?: string | null) {
  return JSON.stringify([String(projectId), String(canvasId || '')]);
}

export function createCollaborationHostScopeFence(initialScopeKey: string): CollaborationHostScopeFence {
  let mounted = false;
  let scopeKey = String(initialScopeKey);
  let generation = 1;

  return Object.freeze({
    mount() {
      if (mounted) return;
      mounted = true;
      generation += 1;
    },
    unmount() {
      if (!mounted) return;
      mounted = false;
      generation += 1;
    },
    setScope(nextScopeKey: string) {
      const normalized = String(nextScopeKey);
      if (normalized === scopeKey) return;
      scopeKey = normalized;
      generation += 1;
    },
    capture() {
      return Object.freeze({ scopeKey, generation });
    },
    isCurrent(token: CollaborationHostScopeToken) {
      return mounted
        && token.scopeKey === scopeKey
        && token.generation === generation;
    },
  });
}

export async function runCollaborationHostScopedMutation<T>(input: {
  fence: CollaborationHostScopeFence;
  token: CollaborationHostScopeToken;
  action: () => Promise<T>;
  onSuccess: (value: T) => void;
  refresh: (token: CollaborationHostScopeToken) => Promise<void>;
  onError: (error: unknown) => void;
  onSettled: () => void;
}): Promise<CollaborationHostScopedMutationResult<T>> {
  if (!input.fence.isCurrent(input.token)) return { status: 'stale' };
  try {
    const value = await input.action();
    if (!input.fence.isCurrent(input.token)) return { status: 'stale' };
    input.onSuccess(value);
    if (!input.fence.isCurrent(input.token)) return { status: 'stale' };
    await input.refresh(input.token);
    if (!input.fence.isCurrent(input.token)) return { status: 'stale' };
    return { status: 'applied', value };
  } catch (error) {
    if (!input.fence.isCurrent(input.token)) return { status: 'stale' };
    input.onError(error);
    return { status: 'failed', error };
  } finally {
    if (input.fence.isCurrent(input.token)) input.onSettled();
  }
}
