import type { RunActionPreview } from './runPreflight.ts';

export interface RunPreflightExecutionSnapshot {
  projectId: string;
  canvasId: string;
  revision: number;
  graphMutationEpoch: number;
}

export type RunPreflightAuthorizationResult =
  | { authorized: true; reason: 'authorized'; preview: RunActionPreview }
  | { authorized: false; reason: 'blocked' | 'cancelled' | 'stale'; preview: RunActionPreview | null };

export function isSameRunPreflightExecutionSnapshot(
  expected: RunPreflightExecutionSnapshot,
  current: RunPreflightExecutionSnapshot | null,
) {
  return Boolean(current
    && current.projectId === expected.projectId
    && current.canvasId === expected.canvasId
    && current.revision === expected.revision
    && current.graphMutationEpoch === expected.graphMutationEpoch);
}

/**
 * Coordinates the read-only preview and the user's explicit decision. This
 * helper deliberately knows nothing about Provider calls or Run persistence;
 * callers may start either only after it returns `authorized: true`.
 */
export async function authorizeRunPreflight(input: {
  snapshot: RunPreflightExecutionSnapshot;
  signal: AbortSignal;
  prepare: () => Promise<RunActionPreview>;
  captureCurrent: () => RunPreflightExecutionSnapshot | null;
  present: (preview: RunActionPreview) => Promise<boolean>;
  revalidate: (preview: RunActionPreview) => Promise<RunActionPreview> | RunActionPreview;
}): Promise<RunPreflightAuthorizationResult> {
  const preview = await input.prepare();
  if (input.signal.aborted) return { authorized: false, reason: 'cancelled', preview };
  if (!isSameRunPreflightExecutionSnapshot(input.snapshot, input.captureCurrent())) {
    return { authorized: false, reason: 'stale', preview };
  }

  if (preview.status === 'blocked') {
    await input.present(preview);
    return { authorized: false, reason: 'blocked', preview };
  }

  if (preview.requiresExplicitConfirmation) {
    const confirmed = await input.present(preview);
    if (!confirmed || input.signal.aborted) {
      return { authorized: false, reason: 'cancelled', preview };
    }
  }

  if (!isSameRunPreflightExecutionSnapshot(input.snapshot, input.captureCurrent())) {
    return { authorized: false, reason: 'stale', preview };
  }
  // The final pass may need fresh host state (configured capabilities,
  // collaboration policy/usage, and asset availability). Await it after the
  // user's decision so a long-open confirmation cannot authorize a stale
  // cached diagnostic snapshot.
  const finalPreview = await input.revalidate(preview);
  if (input.signal.aborted) {
    return { authorized: false, reason: 'cancelled', preview: finalPreview };
  }
  if (!isSameRunPreflightExecutionSnapshot(input.snapshot, input.captureCurrent())) {
    return { authorized: false, reason: 'stale', preview: finalPreview };
  }
  if (finalPreview.status === 'blocked' || finalPreview.digest !== preview.digest) {
    return { authorized: false, reason: 'stale', preview: finalPreview };
  }
  return { authorized: true, reason: 'authorized', preview: finalPreview };
}
