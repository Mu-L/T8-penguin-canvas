const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type CanvasEntityWithUid = {
  id: string;
  entityUid?: unknown;
};

export function isCanonicalEntityUid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function fallbackUuidV4(): string {
  const bytes = new Uint8Array(16);
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function createCanvasEntityUid(): string {
  const generated = globalThis.crypto?.randomUUID?.() || fallbackUuidV4();
  if (!isCanonicalEntityUid(generated)) throw new Error('无法生成稳定画布实体 UUID');
  return generated.toLowerCase();
}

/**
 * New runtime entities receive UUIDs before entering React state. Existing
 * identities are immutable: malformed or duplicate values fail closed instead
 * of being silently replaced, because replacement would break tombstones,
 * comments, CRDT bindings, provenance and personal undo.
 */
export function ensureCanvasEntityUids<T extends CanvasEntityWithUid>(
  entities: readonly T[],
  entityType: 'node' | 'edge',
): T[] {
  const seen = new Set<string>();
  let changed = false;
  const output = entities.map((entity) => {
    const displayId = typeof entity?.id === 'string' ? entity.id : '';
    if (!displayId || displayId.length > 240) throw new Error(`${entityType} 显示身份无效`);
    const supplied = entity.entityUid;
    if (supplied != null && !isCanonicalEntityUid(supplied)) {
      throw new Error(`${entityType} ${displayId} 的 entityUid 无效`);
    }
    const entityUid = supplied == null ? createCanvasEntityUid() : supplied.toLowerCase();
    if (seen.has(entityUid)) throw new Error(`${entityType} entityUid 重复: ${entityUid}`);
    seen.add(entityUid);
    if (supplied === entityUid) return entity;
    changed = true;
    return { ...entity, entityUid };
  });
  return changed ? output : entities as T[];
}
