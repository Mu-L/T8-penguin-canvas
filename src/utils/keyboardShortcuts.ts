export type ShortcutScope = 'global' | 'canvas' | 'connection';

export interface ShortcutCombo {
  key: string;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
}

export interface ShortcutAction {
  id: string;
  group: string;
  label: string;
  description: string;
  scope: ShortcutScope;
  defaults: ShortcutCombo[];
  editable?: boolean;
}

export type ShortcutMap = Record<string, ShortcutCombo[]>;

export interface ShortcutConflict {
  actionId: string;
  label: string;
  combo: ShortcutCombo;
}

const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'OS']);

export const DEFAULT_SHORTCUTS: ShortcutAction[] = [
  { id: 'canvas.undo', group: '编辑', label: '撤销', description: '撤销画布历史', scope: 'canvas', defaults: [{ key: 'Z', ctrl: true }] },
  { id: 'canvas.redo', group: '编辑', label: '重做', description: '恢复画布历史', scope: 'canvas', defaults: [{ key: 'Y', ctrl: true }, { key: 'Z', ctrl: true, shift: true }] },
  { id: 'canvas.copy', group: '编辑', label: '复制', description: '复制选中节点', scope: 'canvas', defaults: [{ key: 'C', ctrl: true }] },
  { id: 'canvas.paste', group: '编辑', label: '粘贴', description: '粘贴节点，自动偏移', scope: 'canvas', defaults: [{ key: 'V', ctrl: true }] },
  { id: 'canvas.paste-links', group: '编辑', label: '连边粘贴', description: '粘贴并保留与原画布邻居的连接', scope: 'canvas', defaults: [{ key: 'V', ctrl: true, shift: true }] },
  { id: 'canvas.duplicate', group: '编辑', label: '快速复制', description: '复制并立即粘贴选中节点', scope: 'canvas', defaults: [{ key: 'D', ctrl: true }] },
  { id: 'canvas.delete', group: '编辑', label: '删除', description: '删除选中节点或连线', scope: 'canvas', defaults: [{ key: 'Delete' }, { key: 'Backspace' }] },
  { id: 'canvas.select-all', group: '编辑', label: '全选', description: '选中当前画布全部节点', scope: 'canvas', defaults: [{ key: 'A', ctrl: true }] },
  { id: 'canvas.group', group: '组织', label: '快捷打组', description: '把选中节点放入一个节点组', scope: 'canvas', defaults: [{ key: 'G', ctrl: true }] },
  { id: 'canvas.overview', group: '导航', label: '缩放到全貌', description: '画布空白处缩放到当前画布全貌', scope: 'canvas', defaults: [{ key: 'Z' }] },
  { id: 'canvas.nearest-node', group: '导航', label: '定位最近节点', description: '画布空白处定位当前视野最近节点', scope: 'canvas', defaults: [{ key: 'G' }] },
  { id: 'canvas.center-view', group: '导航', label: '回到画布中心', description: '未选中节点时快速跳回画布中央位置', scope: 'canvas', defaults: [{ key: 'Home' }] },
  { id: 'global.resource-library', group: '窗口', label: '资源库', description: '未选中节点时打开或关闭资源库', scope: 'canvas', defaults: [{ key: 'R' }] },
  { id: 'global.sidebar-toggle', group: '窗口', label: '隐藏/显示侧边栏', description: '切换左侧画布与节点侧边栏，给小屏幕释放画布空间', scope: 'canvas', defaults: [{ key: 'H' }] },
  { id: 'editor.expand-prompt', group: '输入', label: '放大编辑提示词', description: '聚焦提示词输入框时打开大编辑器', scope: 'global', defaults: [{ key: 'Enter', alt: true }] },
  { id: 'connection.pan-mode', group: '连线', label: '连线导航模式', description: '拖线中保留起点并允许平移画布', scope: 'connection', defaults: [{ key: 'Space' }] },
];

export function cloneShortcutCombo(combo: ShortcutCombo): ShortcutCombo {
  return {
    key: combo.key,
    ctrl: !!combo.ctrl || undefined,
    shift: !!combo.shift || undefined,
    alt: !!combo.alt || undefined,
  };
}

export function normalizeShortcutCombo(combo: ShortcutCombo | null | undefined): ShortcutCombo | null {
  if (!combo || !combo.key) return null;
  return {
    key: normalizeEventKey(combo.key),
    ctrl: !!combo.ctrl || undefined,
    shift: !!combo.shift || undefined,
    alt: !!combo.alt || undefined,
  };
}

export function getDefaultShortcutMap(actions = DEFAULT_SHORTCUTS): ShortcutMap {
  return Object.fromEntries(
    actions.map((action) => [action.id, action.defaults.map((combo) => cloneShortcutCombo(combo))]),
  );
}

export function mergeShortcutMap(actions: ShortcutAction[], persisted?: Partial<ShortcutMap> | null): ShortcutMap {
  const defaults = getDefaultShortcutMap(actions);
  if (!persisted) return defaults;
  const next: ShortcutMap = { ...defaults };
  for (const action of actions) {
    const stored = persisted[action.id];
    if (!Array.isArray(stored)) continue;
    next[action.id] = stored
      .map((combo) => normalizeShortcutCombo(combo))
      .filter((combo): combo is ShortcutCombo => !!combo && validateShortcutCombo(combo).ok);
  }
  return next;
}

export function formatShortcutCombo(combo: ShortcutCombo | null | undefined): string {
  if (!combo) return '';
  const parts: string[] = [];
  if (combo.ctrl) parts.push('Ctrl');
  if (combo.alt) parts.push('Alt');
  if (combo.shift) parts.push('Shift');
  parts.push(combo.key);
  return parts.join('+');
}

export function formatShortcutList(combos: ShortcutCombo[] | null | undefined): string {
  if (!combos || combos.length === 0) return '未设置';
  return combos.map(formatShortcutCombo).filter(Boolean).join(' / ') || '未设置';
}

function normalizeEventKey(key: string): string {
  if (key === ' ' || key === 'Spacebar') return 'Space';
  if (key.length === 1) return key.toUpperCase();
  if (key.toLowerCase() === 'esc') return 'Escape';
  if (key.toLowerCase() === 'del') return 'Delete';
  return key[0]?.toUpperCase() + key.slice(1);
}

export function keyboardEventToShortcutCombo(event: KeyboardEvent): ShortcutCombo | null {
  const hasCommandModifier = event.ctrlKey || event.metaKey;
  if (event.isComposing && !hasCommandModifier) return null;
  const physicalLetter = hasCommandModifier ? /^Key([A-Z])$/i.exec(event.code)?.[1] : undefined;
  const rawKey = event.code === 'Space'
    ? 'Space'
    : physicalLetter
      ? physicalLetter.toUpperCase()
      : normalizeEventKey(event.key);
  if (!rawKey) return null;
  return normalizeShortcutCombo({
    key: rawKey,
    ctrl: event.ctrlKey || event.metaKey,
    shift: event.shiftKey,
    alt: event.altKey,
  });
}

export function shortcutSignature(combo: ShortcutCombo | null | undefined): string {
  const normalized = normalizeShortcutCombo(combo);
  if (!normalized) return '';
  return [
    normalized.ctrl ? '1' : '0',
    normalized.alt ? '1' : '0',
    normalized.shift ? '1' : '0',
    normalized.key.toLowerCase(),
  ].join(':');
}

export function shortcutMatchesEvent(combo: ShortcutCombo, event: KeyboardEvent): boolean {
  const incoming = keyboardEventToShortcutCombo(event);
  if (!incoming) return false;
  return shortcutSignature(combo) === shortcutSignature(incoming);
}

export function matchesAnyShortcut(combos: ShortcutCombo[] | undefined, event: KeyboardEvent): boolean {
  return !!combos?.some((combo) => shortcutMatchesEvent(combo, event));
}

export function validateShortcutCombo(combo: ShortcutCombo | null | undefined): { ok: boolean; reason?: 'empty' | 'modifier-only' | 'reserved' } {
  const normalized = normalizeShortcutCombo(combo);
  if (!normalized) return { ok: false, reason: 'empty' };
  if (MODIFIER_KEYS.has(normalized.key)) return { ok: false, reason: 'modifier-only' };
  if (isReservedShortcut(normalized)) return { ok: false, reason: 'reserved' };
  return { ok: true };
}

export function isReservedShortcut(combo: ShortcutCombo): boolean {
  const key = combo.key.toLowerCase();
  const ctrl = !!combo.ctrl;
  const alt = !!combo.alt;
  const shift = !!combo.shift;

  if (key === 'f5') return true;
  if (alt && key === 'f4') return true;
  if (ctrl && !alt && !shift && ['r', 'w', 't', 'n', 'l'].includes(key)) return true;
  if (ctrl && shift && !alt && ['r', 'w', 't', 'n', 'i', 'j'].includes(key)) return true;
  return false;
}

export function findShortcutConflicts(
  actions: ShortcutAction[],
  current: ShortcutMap,
  actionId: string,
  candidateCombos: ShortcutCombo[],
): ShortcutConflict[] {
  const source = actions.find((action) => action.id === actionId);
  if (!source) return [];
  const candidate = new Set(candidateCombos.map(shortcutSignature).filter(Boolean));
  if (candidate.size === 0) return [];

  const conflicts: ShortcutConflict[] = [];
  for (const action of actions) {
    if (action.id === actionId || action.scope !== source.scope) continue;
    for (const combo of current[action.id] || []) {
      if (!candidate.has(shortcutSignature(combo))) continue;
      conflicts.push({ actionId: action.id, label: action.label, combo });
    }
  }
  return conflicts;
}

export function resetShortcutAction(actions: ShortcutAction[], current: ShortcutMap, actionId: string): ShortcutMap {
  const action = actions.find((item) => item.id === actionId);
  if (!action) return current;
  return {
    ...current,
    [actionId]: action.defaults.map((combo) => cloneShortcutCombo(combo)),
  };
}

export function resetAllShortcuts(actions: ShortcutAction[], _current?: ShortcutMap): ShortcutMap {
  return getDefaultShortcutMap(actions);
}
