import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

const source = readFileSync(
  new URL('../src/components/CollaborationConflictPanel.tsx', import.meta.url),
  'utf8',
).replace(/\r\n?/g, '\n');

function loadPureExports() {
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: 'CollaborationConflictPanel.tsx',
  }).outputText;
  const module = { exports: {} as Record<string, unknown> };
  const jsxRuntime = { Fragment: Symbol('Fragment'), jsx: () => null, jsxs: () => null };
  const react = {
    useCallback: (value: unknown) => value,
    useEffect: () => undefined,
    useId: () => 'test-id',
    useMemo: (factory: () => unknown) => factory(),
    useRef: (value: unknown) => ({ current: value }),
    useState: (value: unknown) => [value, () => undefined],
  };
  const icon = () => null;
  const localRequire = (id: string) => {
    if (id === 'react') return react;
    if (id === 'react/jsx-runtime') return jsxRuntime;
    if (id === 'lucide-react') {
      return {
        AlertTriangle: icon,
        Clipboard: icon,
        FileText: icon,
        RefreshCw: icon,
        RotateCcw: icon,
        Trash2: icon,
        Workflow: icon,
      };
    }
    throw new Error(`unexpected import: ${id}`);
  };
  const evaluate = new Function('require', 'module', 'exports', output);
  evaluate(localRequire, module, module.exports);
  return module.exports as {
    COLLABORATION_CONFLICT_PANEL_MAX_ITEMS: number;
    COLLABORATION_CONFLICT_PREVIEW_MAX_CODEPOINTS: number;
    collaborationConflictActions: (item: Record<string, unknown>) => string[];
    collaborationConflictReasonLabel: (reason: string) => string;
    truncateCollaborationConflictPreview: (
      text: string,
      max?: number,
    ) => { text: string; truncated: boolean; totalCodepoints: number };
    visibleCollaborationConflictItems: (items: Record<string, unknown>[]) => Record<string, unknown>[];
  };
}

const component = loadPureExports();

const target = {
  entityType: 'node',
  entityUid: '11111111-1111-4111-8111-111111111111',
  displayId: 'node-a',
  label: 'Prompt 节点',
};

function textConflict(id = 'text-conflict') {
  return {
    id,
    kind: 'text',
    reason: 'deleted',
    target,
    field: 'prompt',
    localText: '尚未提交的本地 Prompt',
    createdAt: 1,
  };
}

function structureConflict(id = 'structure-conflict') {
  return {
    id,
    kind: 'structure',
    reason: 'revision',
    target,
    field: 'position',
    canExplicitRestore: true,
    createdAt: 2,
  };
}

test('F4 conflict action model keeps text and structure recovery strictly separate', () => {
  assert.deepEqual(component.collaborationConflictActions(textConflict()), ['copy', 'discard']);
  assert.deepEqual(component.collaborationConflictActions(structureConflict()), ['resync', 'restore']);
  for (const reason of ['deleted', 'binding_epoch', 'schema', 'revision', 'permission', 'offline']) {
    assert.ok(component.collaborationConflictReasonLabel(reason).length > 0);
  }

  const textBranch = source.slice(
    source.indexOf("{item.kind === 'text' ? (", source.indexOf('aria-label={`${item.kind')),
    source.indexOf('</article>', source.indexOf('aria-label={`${item.kind')),
  );
  assert.match(textBranch, /runAction\(item, index, 'copy'\)/);
  assert.match(textBranch, /runAction\(item, index, 'discard'\)/);
  assert.match(textBranch, /runAction\(item, index, 'resync'\)/);
  assert.match(textBranch, /runAction\(item, index, 'restore'\)/);
  assert.match(source, /if \(action === 'restore' && \(item\.kind !== 'structure' \|\| !item\.canExplicitRestore\)\) return;/);
  assert.match(source, /await onCopyText\(item, item\.localText\)/, 'copy callback receives exact, not preview-truncated text');
});

test('F4 local text preview is Unicode-safe and bounded without changing the exact recovery text', () => {
  const preview = component.truncateCollaborationConflictPreview('甲😀乙😀丙', 4);
  assert.deepEqual(preview, { text: '甲😀乙😀…', truncated: true, totalCodepoints: 5 });
  assert.equal(component.COLLABORATION_CONFLICT_PREVIEW_MAX_CODEPOINTS, 800);
  assert.match(source, /max-h-36 overflow-auto whitespace-pre-wrap break-words/);
  assert.match(source, /preview\.totalCodepoints/);
  assert.match(source, /preview\.text \|\| '（本地文本为空）'/);
  assert.match(source, /data-testid="collaboration-conflict-full-text-disclosure"/);
  assert.match(source, /展开完整正文并手工复制/);
  assert.match(source, /expandedTextIds\.has\(item\.id\)/, 'full text is rendered only after disclosure');
  assert.match(source, /value=\{item\.localText\}/, 'manual recovery receives exact, untruncated text');
  assert.match(source, /data-testid="collaboration-conflict-full-text"/);
  assert.match(source, /event\.currentTarget\.select\(\)/);
  assert.doesNotMatch(source, /title=\{item\.localText\}/, 'full local recovery text must not leak through an unbounded title');
});

test('F4 conflict list rejects malformed and duplicate items and caps rendering work', () => {
  const many = Array.from({ length: 120 }, (_, index) => (
    index === 1 ? textConflict('text-conflict') : textConflict(`conflict-${index}`)
  ));
  many.unshift(textConflict('text-conflict'));
  many.unshift({ ...textConflict('bad-reason'), reason: 'invented' });
  const visible = component.visibleCollaborationConflictItems(many);
  assert.equal(visible.length, component.COLLABORATION_CONFLICT_PANEL_MAX_ITEMS);
  assert.equal(new Set(visible.map((item) => item.id)).size, visible.length);
  assert.equal(visible.some((item) => item.id === 'bad-reason'), false);

  assert.match(source, /只显示前 \{COLLABORATION_CONFLICT_PANEL_MAX_ITEMS\} 条有效且不重复的冲突/);
  assert.match(source, /data-memory-only-recovery="true"/);
  assert.match(source, /内容仍只保留在当前页面内存中/);
  assert.doesNotMatch(source, /localStorage|sessionStorage|indexedDB|Storage\b|saveCollaborationQueue|collaborationQueueStorageKey/);
});

test('F4 failed automatic copy keeps the exact memory recovery available for manual selection', () => {
  const actionStart = source.indexOf('  const runAction = useCallback');
  const actionEnd = source.indexOf('\n\n  return (', actionStart);
  const action = source.slice(actionStart, actionEnd);
  assert.match(action, /await onCopyText\(item, item\.localText\)/);
  assert.match(action, /catch \(error\)/);
  assert.match(action, /恢复内容仍保留在本页内存中；可展开完整正文并手工选择复制/);
  assert.ok(
    action.indexOf('setTextExpanded(item.id, false)') < action.indexOf('} catch (error)'),
    'the disclosure is collapsed only after the copy callback succeeds',
  );
});

test('F4 panel exposes target, field, reason, kind, empty state, and accessible focus behavior', () => {
  assert.match(source, /data-conflict-kind=\{item\.kind\}/);
  assert.match(source, /data-conflict-reason=\{item\.reason\}/);
  assert.match(source, /目标：\{targetName\}/);
  assert.match(source, /entityUid: \{item\.target\.entityUid\}/);
  assert.match(source, /字段：\{boundedDisplay\(item\.field/);
  assert.match(source, /原因：\{reason\.description\}/);
  assert.match(source, /本地文本预览/);
  assert.match(source, /没有需要处理的协作冲突/);
  assert.match(source, /aria-labelledby=\{titleId\}/);
  assert.match(source, /aria-describedby=\{descriptionId\}/);
  assert.match(source, /role="status" aria-live="polite" aria-atomic="true"/);
  assert.match(source, /tabIndex=\{-1\}/);
  assert.match(source, /window\.requestAnimationFrame\(\(\) => focusItemAt\(0\)\)/);
  assert.match(source, /removedInvokedItem/);
  assert.match(source, /event\.key === 'ArrowDown'/);
  assert.match(source, /event\.key === 'ArrowUp'/);
  assert.match(source, /event\.key === 'Home'/);
  assert.match(source, /event\.key === 'End'/);
  assert.match(source, /focus-visible:ring-2/);
  assert.match(source, /aria-hidden="true"/);
});

test('F4 restore remains explicit and unavailable without tombstone-bound authority', () => {
  assert.match(source, /Only true when the authority has supplied an explicit tombstone-bound restore path/);
  assert.match(source, /disabled=\{anyPending \|\| !item\.canExplicitRestore\}/);
  assert.match(source, /缺少可验证的 tombstone 恢复身份/);
  assert.match(source, /绝不会自动复活对象/);
  assert.match(source, /仍需通过主机权威校验/);
  const effectStart = source.indexOf('  useEffect(() => {');
  const effectEnd = source.indexOf('\n\n  const runAction', effectStart);
  assert.ok(effectStart >= 0 && effectEnd > effectStart);
  assert.doesNotMatch(
    source.slice(effectStart, effectEnd),
    /onExplicitRestoreStructure\(/,
    'effects must never auto-trigger restore',
  );
});
