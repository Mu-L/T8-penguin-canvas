export interface CanvasDatabaseRecoveryPlan {
  available: true;
  planId: string;
  expiresAt: number;
  potentiallyDiscardedWriteCount: number;
  reasons: string[];
}

export function canvasDatabaseRecoveryPlanFromPayload(
  payload: unknown,
  now = Date.now(),
): CanvasDatabaseRecoveryPlan | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const recovery = (payload as Record<string, unknown>).recovery;
  if (!recovery || typeof recovery !== 'object' || Array.isArray(recovery)) return null;
  const candidate = recovery as Record<string, unknown>;
  const planId = String(candidate.planId || '').trim().toLowerCase();
  const expiresAt = Number(candidate.expiresAt);
  const potentiallyDiscardedWriteCount = Number(candidate.potentiallyDiscardedWriteCount);
  const reasons = Array.isArray(candidate.reasons)
    ? candidate.reasons.filter((reason): reason is string => typeof reason === 'string')
    : [];
  if (candidate.available !== true
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(planId)
    || !Number.isSafeInteger(expiresAt)
    || expiresAt <= now
    || !Number.isSafeInteger(potentiallyDiscardedWriteCount)
    || potentiallyDiscardedWriteCount < 0
    || reasons.length === 0) return null;
  return {
    available: true,
    planId,
    expiresAt,
    potentiallyDiscardedWriteCount,
    reasons,
  };
}
