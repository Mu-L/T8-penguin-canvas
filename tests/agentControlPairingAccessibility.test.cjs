'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

test('Agent Control pairing dialog owns keyboard focus without weakening explicit approval', () => {
  const source = fs.readFileSync(
    path.join(root, 'src', 'components', 'AgentControlPairingModal.tsx'),
    'utf8',
  );

  assert.match(source, /data-agent-control-pairing-dialog/);
  assert.match(source, /aria-describedby="agent-control-pairing-description"/);
  assert.match(source, /tabIndex=\{-1\}/);
  assert.match(source, /dialogRef\.current\?\.focus\(\)/);
  assert.match(source, /event\.key === 'Escape'/);
  assert.match(source, /event\.key !== 'Tab'/);
  assert.match(source, /event\.shiftKey/);
  assert.match(source, /restorePreviousFocus/);
  assert.match(source, /previous\?\.isConnected/);
  assert.match(source, /if \(!confirmed \|\| !approvedScopes\.length \|\| busy\) return/);
  assert.match(source, /我已核对验证码/);
  assert.doesNotMatch(source, /void approve\(\).*Escape/s);
});

test('real Electron pairing acceptance covers focus trap, Escape denial, and focus restoration', () => {
  const source = fs.readFileSync(
    path.join(root, 'scripts', 'verify-creator-agent-p4-pairing.cjs'),
    'utf8',
  );

  assert.match(source, /exerciseKeyboardDenial/);
  assert.match(source, /pressKey\(cdp, 'Tab'\)/);
  assert.match(source, /pressKey\(cdp, 'Tab', \{ shiftKey: true \}\)/);
  assert.match(source, /pressKey\(cdp, 'Escape'\)/);
  assert.match(source, /p4-pairing-focus-sentinel/);
  assert.match(source, /keyboardEscapeDenied: true/);
  assert.match(source, /previousFocusRestored: true/);
});
