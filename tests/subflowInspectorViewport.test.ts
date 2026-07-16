import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildSubflowInspectorViewportKey } from '../src/utils/subflowInspectorViewport.ts';

test('subflow inspector viewport keys are stable for the same hierarchy layer', () => {
  const options = {
    rootInstanceNodeId: 'root-instance',
    pathNodeIds: ['root-instance', 'nested-instance'],
    projectId: 'project-a',
    definitionId: 'shared-definition',
    definitionVersion: 3,
  };
  assert.equal(buildSubflowInspectorViewportKey(options), buildSubflowInspectorViewportKey({ ...options }));
});

test('same definition keeps independent viewports by instance path and edit mode', () => {
  const base = {
    rootInstanceNodeId: 'root-instance',
    projectId: 'project-a',
    definitionId: 'shared-definition',
    definitionVersion: 3,
  };
  const left = buildSubflowInspectorViewportKey({ ...base, pathNodeIds: ['root-instance', 'left'] });
  const right = buildSubflowInspectorViewportKey({ ...base, pathNodeIds: ['root-instance', 'right'] });
  const editing = buildSubflowInspectorViewportKey({ ...base, pathNodeIds: ['root-instance', 'left'], editing: true });
  assert.notEqual(left, right);
  assert.notEqual(left, editing);
});

test('subflow inspector keeps its actions and graph reachable on narrow viewports', () => {
  const source = readFileSync(new URL('../src/components/Canvas.tsx', import.meta.url), 'utf8');
  assert.match(source, /flex basis-full flex-wrap items-center justify-end gap-2 sm:basis-auto sm:flex-nowrap/);
  assert.match(source, /overflow-y-auto md:grid-cols-\[minmax\(0,1fr\)_280px\] md:overflow-hidden/);
  assert.match(source, /h-\[42vh\] min-h-\[260px\].*md:h-\[68vh\] md:min-h-\[420px\]/);
});
