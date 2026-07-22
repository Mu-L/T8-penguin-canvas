import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  DEFAULT_SHORTCUTS,
  findShortcutConflicts,
  formatShortcutCombo,
  getDefaultShortcutMap,
  keyboardEventToShortcutCombo,
  resetAllShortcuts,
  resetShortcutAction,
  shortcutMatchesEvent,
  validateShortcutCombo,
} from '../src/utils/keyboardShortcuts.ts';

const event = (key: string, init: Partial<KeyboardEvent> = {}) => ({
  key,
  code: init.code || '',
  ctrlKey: !!init.ctrlKey,
  metaKey: !!init.metaKey,
  shiftKey: !!init.shiftKey,
  altKey: !!init.altKey,
  repeat: !!init.repeat,
  isComposing: !!init.isComposing,
}) as KeyboardEvent;

test('keyboardEventToShortcutCombo normalizes modifier combinations', () => {
  assert.equal(formatShortcutCombo(keyboardEventToShortcutCombo(event('z', { ctrlKey: true, shiftKey: true }))), 'Ctrl+Shift+Z');
  assert.equal(formatShortcutCombo(keyboardEventToShortcutCombo(event(' ', { code: 'Space' }))), 'Space');
  assert.equal(formatShortcutCombo(keyboardEventToShortcutCombo(event('Delete'))), 'Delete');
});

test('validateShortcutCombo rejects pure modifiers and dangerous browser shortcuts', () => {
  assert.deepEqual(validateShortcutCombo(keyboardEventToShortcutCombo(event('Control', { ctrlKey: true }))).ok, false);
  assert.deepEqual(validateShortcutCombo(keyboardEventToShortcutCombo(event('r', { ctrlKey: true }))).reason, 'reserved');
  assert.deepEqual(validateShortcutCombo(keyboardEventToShortcutCombo(event('F5'))).reason, 'reserved');
  assert.deepEqual(validateShortcutCombo(keyboardEventToShortcutCombo(event('q', { ctrlKey: true, altKey: true }))).ok, true);
});

test('shortcutMatchesEvent treats Ctrl defaults as Ctrl or Meta for cross-platform users', () => {
  const copy = getDefaultShortcutMap()['canvas.copy'][0];

  assert.equal(shortcutMatchesEvent(copy, event('c', { ctrlKey: true })), true);
  assert.equal(shortcutMatchesEvent(copy, event('c', { metaKey: true })), true);
  assert.equal(shortcutMatchesEvent(copy, event('c')), false);
});

test('findShortcutConflicts detects collisions inside the same editable scope', () => {
  const current = getDefaultShortcutMap();
  const conflicts = findShortcutConflicts(DEFAULT_SHORTCUTS, current, 'canvas.copy', current['canvas.paste']);

  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].actionId, 'canvas.paste');
});

test('resource library shortcut conflicts with canvas-visible shortcuts', () => {
  const current = getDefaultShortcutMap();
  const conflicts = findShortcutConflicts(DEFAULT_SHORTCUTS, current, 'global.resource-library', current['canvas.nearest-node']);

  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].actionId, 'canvas.nearest-node');
});

test('command shortcuts use physical letter codes across keyboard layouts and stale IME composition', () => {
  const localizedCopy = event('с', { code: 'KeyC', ctrlKey: true, isComposing: true });
  const localizedPaste = event('ν', { code: 'KeyV', metaKey: true });

  assert.equal(formatShortcutCombo(keyboardEventToShortcutCombo(localizedCopy)), 'Ctrl+C');
  assert.equal(formatShortcutCombo(keyboardEventToShortcutCombo(localizedPaste)), 'Ctrl+V');
});

test('sidebar toggle defaults to H and stays in the canvas window group', () => {
  const action = DEFAULT_SHORTCUTS.find((item) => item.id === 'global.sidebar-toggle');

  assert.ok(action);
  assert.equal(action.group, '窗口');
  assert.equal(action.label, '隐藏/显示侧边栏');
  assert.equal(getDefaultShortcutMap()['global.sidebar-toggle']?.[0]?.key, 'H');
});

test('reset helpers restore one action or the whole shortcut map to defaults', () => {
  const current = {
    ...getDefaultShortcutMap(),
    'canvas.copy': [keyboardEventToShortcutCombo(event('q', { ctrlKey: true, altKey: true }))!],
    'canvas.paste': [],
  };

  assert.deepEqual(resetShortcutAction(DEFAULT_SHORTCUTS, current, 'canvas.copy')['canvas.copy'], getDefaultShortcutMap()['canvas.copy']);
  assert.deepEqual(resetAllShortcuts(DEFAULT_SHORTCUTS, current), getDefaultShortcutMap());
});

test('toolbar exposes editable shortcut controls instead of a static help list', () => {
  const toolbar = readFileSync(new URL('../src/components/CanvasToolbar.tsx', import.meta.url), 'utf8');

  assert.match(toolbar, /快捷键设置/);
  assert.match(toolbar, /全部恢复默认/);
  assert.match(toolbar, /setRecordingActionId/);
  assert.match(toolbar, /clearActionShortcuts/);
  assert.match(toolbar, /resetShortcutAction/);
  assert.doesNotMatch(toolbar, /快捷键说明/);
});
