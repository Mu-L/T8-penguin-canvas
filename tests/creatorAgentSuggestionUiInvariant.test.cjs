'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

function source(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

test('Creator Agent renders suggestion buttons only behind the complete invariant receipt', () => {
  const panel = source('src/components/CreatorAgentPanel.tsx');
  const service = source('src/services/creatorAgent.ts');
  assert.match(service, /interface CreatorAgentSuggestionInvariantReceipt/);
  assert.match(service, /schema: 't8-creator-suggestion-invariant-receipt-v1'/);
  assert.match(panel, /creatorSuggestionSetContractReady/);
  assert.match(panel, /receipt\.schema !== 't8-creator-suggestion-invariant-receipt-v1'/);
  assert.match(panel, /receipt\.suggestionSetCount !== 1/);
  assert.match(panel, /receipt\.itemCount !== 3/);
  assert.match(panel, /receipt\.uniqueIdCount !== 3/);
  assert.match(panel, /receipt\.uniqueIntentCount !== 3/);
  assert.match(panel, /receipt\.invalidCapabilityIds\.length !== 0/);
  assert.match(panel, /receipt\.invalidContractCount !== 0/);
  assert.match(panel, /receipt\.fakeEnabledActionCount !== 0/);
  assert.match(panel, /receipt\.unexplainedDisabledActionCount !== 0/);
  assert.match(panel, /receipt\.setDigest !== set\.setDigest/);
  assert.match(panel, /operation\.requiredScopes\.slice\(\)\.sort\(\)/);
  assert.match(panel, /data-suggestion-id=\{suggestion\.id\}/);
  assert.match(panel, /data-suggestion-intent=\{suggestion\.intent\}/);
  assert.match(panel, /data-suggestion-executable=\{suggestion\.executable \? 'true' : 'false'\}/);
  assert.match(panel, /data-required-capabilities=\{suggestion\.requiredCapabilityIds\.join\(','\)\}/);
});
