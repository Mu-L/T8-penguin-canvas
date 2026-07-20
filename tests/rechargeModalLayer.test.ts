import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

function read(path: URL) {
  return readFileSync(path, 'utf8');
}

const rechargeModalPath = new URL('../local-private/recharge/frontend/RechargeModal.tsx', import.meta.url);

test('local recharge modal is layered above the sidebar collapse toggle', { skip: existsSync(rechargeModalPath) ? false : 'local private recharge overlay is not present' }, () => {
  const modal = read(rechargeModalPath);
  const css = read(new URL('../src/styles/index.css', import.meta.url));

  const sidebarZ = Number(css.match(/\.t8-sidebar-toggle\s*\{[\s\S]*?z-index:\s*(\d+)/)?.[1]);
  const rechargeZ = Number(modal.match(/fixed inset-0 z-\[(\d+)\] flex items-center justify-center/)?.[1]);

  assert.ok(Number.isFinite(sidebarZ), 'sidebar toggle z-index should be parseable');
  assert.ok(Number.isFinite(rechargeZ), 'recharge modal z-index should be parseable');
  assert.ok(
    rechargeZ > sidebarZ,
    `recharge modal z-index (${rechargeZ}) must be above sidebar toggle (${sidebarZ})`,
  );
});
