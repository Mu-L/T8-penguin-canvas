'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MAX_GIT_OUTPUT_BYTES,
  findDeniedAddedText,
} = require('../scripts/check-public-clean.cjs');

test('public clean scanner keeps a bounded large Git buffer for checkpoint diffs', () => {
  assert.equal(MAX_GIT_OUTPUT_BYTES, 64 * 1024 * 1024);
});

test('public clean scanner distinguishes the private route from ordinary payload text', () => {
  const privatePath = ['/', 'pay'].join('');
  assert.deepEqual(findDeniedAddedText('assert /payload and value.payload are safe words'), []);
  for (const suffix of ['', '/', '?next=1', '#result', ' "quoted"']) {
    assert.deepEqual(findDeniedAddedText(`route ${privatePath}${suffix}`), [privatePath]);
  }
});
