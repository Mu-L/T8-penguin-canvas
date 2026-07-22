export type AltModifierLike = {
  altKey?: boolean;
  getModifierState?: (key: 'Alt') => boolean;
};

export function isAltModifierActive(
  event: AltModifierLike | null | undefined,
  latchedAlt = false,
): boolean {
  if (latchedAlt || event?.altKey === true) return true;
  try {
    return event?.getModifierState?.('Alt') === true;
  } catch {
    return false;
  }
}
