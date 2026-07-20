import assert from 'node:assert/strict';
import test from 'node:test';

import {
  mergeCanvasPatchEntities,
  mergeCanvasPatchEntitiesWithConflicts,
  mergeCanvasPatchValueWithConflicts,
} from '../src/utils/canvasPatchMerge.ts';

test('CanvasPatch three-way merge combines authoritative and later local node fields', () => {
  const base = [{ id: 'n1', position: { x: 0, y: 0 }, data: { status: 'idle', output: '' } }];
  const local = [{ id: 'n1', position: { x: 0, y: 0 }, data: { status: 'done', output: 'late-result' } }];
  const authoritative = [{ id: 'n1', position: { x: 80, y: 40 }, data: { status: 'idle', output: '' } }];

  assert.deepEqual(mergeCanvasPatchEntities(base, local, authoritative), [{
    id: 'n1',
    position: { x: 80, y: 40 },
    data: { status: 'done', output: 'late-result' },
  }]);
  assert.equal(base[0].position.x, 0);
  assert.equal(authoritative[0].data.status, 'idle');
});

test('CanvasPatch three-way merge reports both deletion conflicts and preserves later local intent', () => {
  const base = [{ id: 'n1', data: { value: 1 } }];
  const localChanged = [{ id: 'n1', data: { value: 2 } }];
  const authoritativeChanged = [{ id: 'n1', data: { value: 3 } }];

  const patchDelete = mergeCanvasPatchEntitiesWithConflicts(base, localChanged, [], 'nodes');
  assert.deepEqual(patchDelete.value, localChanged);
  assert.equal(patchDelete.conflicts[0]?.kind, 'edit-delete');

  const localDelete = mergeCanvasPatchEntitiesWithConflicts(base, [], authoritativeChanged, 'nodes');
  assert.deepEqual(localDelete.value, []);
  assert.equal(localDelete.conflicts[0]?.kind, 'delete-edit');
});

test('CanvasPatch three-way merge restores authoritative entities and retains unrelated local additions', () => {
  const local = [{ id: 'local', data: { value: 1 } }];
  const authoritative = [{ id: 'restored', data: { value: 2 } }];
  assert.deepEqual(mergeCanvasPatchEntities([], local, authoritative), [
    { id: 'restored', data: { value: 2 } },
    { id: 'local', data: { value: 1 } },
  ]);
});

test('CanvasPatch three-way merge treats arrays atomically and filters unsafe object keys', () => {
  const base = { items: ['base'], nested: { stable: true } };
  const local = JSON.parse('{"items":["local"],"nested":{"stable":true,"__proto__":{"polluted":true}}}');
  const authoritative = { items: ['server'], nested: { stable: true, server: 1 } };
  const result = mergeCanvasPatchValueWithConflicts<Record<string, any>>(base, local, authoritative);
  const merged = result.value;
  assert.deepEqual(merged.items, ['local']);
  assert.deepEqual(merged.nested, { stable: true, server: 1 });
  assert.ok(result.conflicts.some((item) => item.kind === 'same-field' && item.path.endsWith('.items')));
  assert.equal(({} as any).polluted, undefined);
});
