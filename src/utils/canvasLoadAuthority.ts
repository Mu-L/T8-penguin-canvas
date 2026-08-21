export interface CanvasWriteAuthority {
  activeCanvasId: string | null;
  loadedCanvasId: string | null;
  loaded: boolean;
  revision: unknown;
}

export function authoritativeCanvasRevision(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
    ? value
    : null;
}

export function requireAuthoritativeCanvasRevision(value: unknown): number {
  const revision = authoritativeCanvasRevision(value);
  if (revision === null) {
    throw new Error('服务端返回的画布 revision 无效，已阻止编辑和保存');
  }
  return revision;
}

export function hasCanvasWriteAuthority(input: CanvasWriteAuthority): boolean {
  return Boolean(
    input.loaded
    && input.activeCanvasId
    && input.loadedCanvasId === input.activeCanvasId
    && authoritativeCanvasRevision(input.revision) !== null
  );
}
