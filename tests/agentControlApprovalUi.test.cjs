'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

test('approval UI supports delivery packaging and exposes version-bound provider, cost, and privacy receipts', () => {
  const modal = fs.readFileSync(
    path.join(root, 'src', 'components', 'AgentControlApprovalModal.tsx'),
    'utf8',
  );
  const globalTypes = fs.readFileSync(
    path.join(root, 'src', 'vite-env.d.ts'),
    'utf8',
  );

  assert.match(modal, /action === 'delivery\.package'/);
  assert.match(modal, /Agent 请求创建交付包/);
  assert.match(modal, /批准创建交付包/);
  assert.match(modal, /平台未提供估算（不阻断；仍按本次明确范围授权）/);
  assert.doesNotMatch(modal, /未知（不可启动）/);
  assert.match(modal, /data-agent-approval-binding=\{approvalBinding\.bindingDigest\}/);
  assert.match(modal, /本次确认绑定的版本与边界/);
  assert.match(modal, /计划版本：\{digestLabel\(approvalBinding\.planDigest\)\}/);
  assert.match(modal, /平台 \/ 模型：/);
  assert.match(modal, /费用边界：/);
  assert.match(modal, /隐私边界：/);
  assert.match(modal, /这个确认会自动失效，必须重新核对/);
  assert.match(globalTypes, /'delivery\.package'/);
  assert.match(globalTypes, /interface T8AgentControlApprovalBinding/);
  assert.match(globalTypes, /approvalBinding\?: T8AgentControlApprovalBinding \| null/);
});
