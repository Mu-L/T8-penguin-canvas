import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const hook = readFileSync(new URL('../src/hooks/useRunTrigger.ts', import.meta.url), 'utf8');

function orderedIndex(source: string, patterns: RegExp[]) {
  let cursor = 0;
  return patterns.map((pattern) => {
    const match = pattern.exec(source.slice(cursor));
    assert.ok(match, `missing ordered persistence gate: ${pattern}`);
    cursor += match.index + match[0].length;
    return cursor;
  });
}

test('Provider execution is impossible without a persisted Run, NodeRun, and Attempt', () => {
  assert.match(hook, /if \(!runId\) \{\s*throw new Error\('缺少持久化 Run 上下文，已停止调用 Provider'\);\s*\}/);
  assert.match(hook, /catch \(error\) \{\s*throw new Error\(`无法建立持久化 NodeRun\/Attempt，已停止调用 Provider：/);

  orderedIndex(hook, [
    /if \(!runId\)/,
    /await createProjectNodeRun\(/,
    /await createProjectRunAttempt\(/,
    /await updateProjectNodeRun\(/,
    /resolvePersistenceReady\(\);/,
    /await lifecycle\.reporter\.progress\(\{ phase: 'executing', progress: 0 \}\);/,
    /await \(runFnRef\.current/,
  ]);
});

test('a persistence failure is reported as failed completion without invoking the Provider callback first', () => {
  const persistenceCatch = hook.match(/catch \(error\) \{\s*throw new Error\(`无法建立持久化 NodeRun\/Attempt[\s\S]*?\n\s*\}/)?.[0] || '';
  assert.ok(persistenceCatch);
  assert.doesNotMatch(persistenceCatch, /runFnRef\.current/);
  const completionCatch = hook.match(/catch \(error: any\) \{[\s\S]*?\n\s*\} finally \{/)?.[0] || '';
  assert.ok(completionCatch);
  assert.match(completionCatch, /resolvePersistenceReady\(\);/);
  assert.match(completionCatch, /if \(terminalWrite\) await terminalWrite;/);
  assert.match(completionCatch, /else await persistTerminal\(stopped \? 'stopped' : 'failed', error\);/);
  assert.match(completionCatch, /terminal evidence persistence failed/);
  assert.match(completionCatch, /markDone\(/);
});
