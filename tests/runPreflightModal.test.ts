import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const modal = readFileSync(new URL('../src/components/RunPreflightModal.tsx', import.meta.url), 'utf8');

function sourceBetween(source: string, start: string, end: string) {
  const startIndex = source.indexOf(start);
  assert.notEqual(startIndex, -1, `missing source start: ${start}`);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(endIndex, -1, `missing source end: ${end}`);
  return source.slice(startIndex, endIndex);
}

test('run preflight modal is a high-layer accessible canvas dialog', () => {
  assert.match(modal, /createPortal\(/);
  assert.match(modal, /data-canvas-floating-ui="run-preflight-modal"/);
  assert.match(modal, /className="fixed inset-0 z-\[10100\]/);
  assert.match(modal, /role="dialog"/);
  assert.match(modal, /aria-modal="true"/);
  assert.match(modal, /aria-labelledby=\{titleId\}/);
  assert.match(modal, /aria-describedby=\{descriptionId\}/);
  assert.match(modal, /event\.key === 'Escape'/);
  assert.match(modal, /event\.key !== 'Tab'/);
  assert.match(modal, /previouslyFocused\?\.isConnected/);
});

test('loading state explicitly remains read-only and cannot authorize execution', () => {
  const component = sourceBetween(modal, 'export default function RunPreflightModal', '\n  if (!visible');
  assert.match(component, /const displayedPreview = loading \? null : preview/);
  assert.match(component, /const confirmDisabled = loading \|\| !displayedPreview \|\| displayedPreview\.status === 'blocked'/);
  assert.match(modal, /只读体检，不调用 Provider\/不写 Run/);
  assert.match(modal, /role="status"/);
  assert.match(modal, /aria-live="polite"/);
  assert.doesNotMatch(modal, /\bfetch\s*\(|\baxios\b|createProjectRun|triggerProvider|localStorage|sessionStorage/);
});

test('preview renders exact action, scope, revision, evidence, cost, notices, and digest fields', () => {
  for (const field of [
    'preview.actionKind',
    'preview.scope.projectId',
    'preview.scope.canvasId',
    'preview.scope.currentRevision',
    'preview.scope.expectedRevision',
    'preview.scope.requestId',
    'preview.scope.nodeIds',
    'preview.scope.nodeSetDigest',
    'preview.scope.executionGraphDigest',
    'preview.evidenceRefs',
    'value.runId',
    'value.nodeRunId',
    'value.attemptId',
    'preview.blockers',
    'preview.warnings',
    'preview.digestAlgorithm',
    'preview.digest',
  ]) {
    assert.match(modal, new RegExp(field.replaceAll('.', '\\.')));
  }
  assert.match(modal, /ACTION_LABELS: Record<RunActionKind, string>/);
  assert.match(modal, /DOMAIN_LABELS: Record<RunPreflightNoticeDomain, string>/);
  assert.match(modal, />执行图摘要<\/dt>/);
});

test('unknown cost is described without inventing a number while known cost uses the authoritative fields', () => {
  const cost = sourceBetween(modal, 'preview.cost.known ? (', '\n          )}\n        </div>');
  assert.match(cost, /String\(preview\.cost\.amount\)/);
  assert.match(cost, /preview\.cost\.currency/);
  assert.match(cost, /权威费用未知/);
  assert.match(cost, /不推断金额或调用次数/);
  assert.doesNotMatch(cost, /toFixed|Intl\.NumberFormat|[$¥￥€£]/);
});

test('blocked preview disables confirmation and callback receives the exact displayed preview', () => {
  assert.match(modal, /displayedPreview\.status === 'blocked'/);
  assert.match(modal, /disabled=\{confirmDisabled\}/);
  assert.match(modal, /aria-disabled=\{confirmDisabled\}/);
  assert.match(modal, /if \(!confirmDisabled && displayedPreview\) onConfirm\(displayedPreview\)/);
  assert.match(modal, /确认仅授权此摘要/);
  assert.match(modal, /revision 或节点范围变化后必须重新体检/);
});

test('the modal follows shared theme variables instead of a hard-coded light or dark surface', () => {
  assert.match(modal, /bg-\[var\(--bg-secondary\)\]/);
  assert.match(modal, /bg-\[var\(--bg-primary\)\]/);
  assert.match(modal, /border-\[var\(--border-primary\)\]/);
  assert.match(modal, /text-\[var\(--text-primary\)\]/);
  assert.match(modal, /text-\[var\(--text-secondary\)\]/);
  assert.match(modal, /bg-\[var\(--accent-primary\)\]/);
});
