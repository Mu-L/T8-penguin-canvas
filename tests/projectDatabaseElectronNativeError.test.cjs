'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

test('Electron native SQLite ABI mismatch has an actionable non-secret startup message', () => {
  const source = fs.readFileSync(
    path.join(root, 'backend', 'src', 'services', 'projectDatabase.js'),
    'utf8',
  );
  assert.match(source, /native-binding-incompatible/);
  assert.match(source, /npm run rebuild:electron/);
  assert.match(source, /ERR_DLOPEN_FAILED/);
});
