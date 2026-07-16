import type { AssetPipelineStatus } from '../types/project';

const EMPTY_PREVIEW_COUNTS = { queued: 0, running: 0, retrying: 0, succeeded: 0, failed: 0 };

export function assetPipelineSignature(status: AssetPipelineStatus): string {
  const counts = { ...EMPTY_PREVIEW_COUNTS, ...(status.previews?.counts || {}) };
  return [
    Boolean(status.scan?.running),
    Number(status.previews?.active || 0),
    counts.queued,
    counts.running,
    counts.retrying,
    counts.succeeded,
    counts.failed,
  ].join(':');
}

export function shouldInvalidateAssetCatalog(previousSignature: string, nextSignature: string): boolean {
  if (!previousSignature || previousSignature === nextSignature) return false;
  const previous = previousSignature.split(':');
  const next = nextSignature.split(':');
  const active = (parts: string[]) => parts[0] === 'true' || Number(parts[1]) > 0 || Number(parts[2]) > 0 || Number(parts[3]) > 0 || Number(parts[4]) > 0;
  const terminalCountChanged = previous[5] !== next[5] || previous[6] !== next[6];
  return terminalCountChanged || (active(previous) && !active(next));
}

export function isCurrentAssetSelection(currentAssetId: string | null, targetAssetId: string): boolean {
  return currentAssetId === targetAssetId;
}
