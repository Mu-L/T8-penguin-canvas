'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const {
  CreatorAgentSessionError,
  creatorSuggestionInvariantReceipt,
  creatorSuggestionSet,
} = require('../backend/src/services/creatorAgentSessions.js');

function stableString(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableString).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${stableString(value[key])}`
  )).join(',')}}`;
}

function digestSuggestionSet(set) {
  return crypto.createHash('sha256').update(stableString({
    schema: set.schema,
    binding: set.binding,
    items: set.items,
  })).digest('hex');
}

function assertValidInvariant(set) {
  const receipt = set.invariantReceipt;
  assert.equal(set.items.length, 3);
  assert.equal(new Set(set.items.map((item) => item.id)).size, 3);
  assert.equal(new Set(set.items.map((item) => item.intent)).size, 3);
  assert.equal(receipt.schema, 't8-creator-suggestion-invariant-receipt-v1');
  assert.equal(receipt.suggestionSetCount, 1);
  assert.equal(receipt.itemCount, 3);
  assert.equal(receipt.uniqueIdCount, 3);
  assert.equal(receipt.uniqueIntentCount, 3);
  assert.deepEqual(receipt.invalidCapabilityIds, []);
  assert.equal(receipt.invalidContractCount, 0);
  assert.equal(receipt.fakeEnabledActionCount, 0);
  assert.equal(receipt.unexplainedDisabledActionCount, 0);
  assert.equal(receipt.setDigest, set.setDigest);
  assert.deepEqual(creatorSuggestionInvariantReceipt(set), receipt);
  for (const item of set.items) {
    if (item.executable) {
      assert.deepEqual(item.blockers, []);
      assert.equal(item.disabledReason, '');
    } else {
      assert.equal(
        item.blockers.length > 0 || Boolean(item.disabledReason) || item.unblockActions.length > 0,
        true,
      );
    }
  }
}

test('every Creator suggestion family closes with one valid three-item invariant receipt', () => {
  const cases = [
    [{}, null],
    [{ nodeCount: 4 }, null],
    [{ selectedNodeIds: ['image-a'], selectedNodeTypes: ['image'] }, { kind: 'image' }],
    [{ failedRunCount: 1 }, { kind: 'image' }],
    [{ phase: 'assets' }, { kind: 'story', ready: true, analysis: { stage: 'assets' } }],
    [{ phase: 'shots' }, { kind: 'story', ready: true, analysis: { stage: 'shots' } }],
    [{ phase: 'candidates' }, { kind: 'story', ready: true, analysis: { stage: 'candidates' } }],
    [{}, { kind: 'image' }],
    [{}, { kind: 'video' }],
    [{}, { kind: 'audio' }],
    [{}, { kind: 'delivery' }],
    [{}, {
      kind: 'story',
      planDigest: 'reference-breakdown-plan',
      brief: { recipe: 'shot-breakdown' },
    }],
  ];
  for (const [context, plan] of cases) assertValidInvariant(creatorSuggestionSet(context, plan));
});
test('reference-breakdown keeps its blocked continuation explained without creating a fake button', () => {
  const set = creatorSuggestionSet({}, {
    kind: 'story',
    planDigest: 'reference-breakdown-plan',
    brief: { recipe: 'shot-breakdown' },
  });
  assert.deepEqual(set.items.map((item) => item.executable), [true, true, false]);
  assert.equal(set.items[2].blockers.length, 1);
  assert.ok(set.items[2].disabledReason);
  assert.ok(set.items[2].unblockActions.length > 0);
  assertValidInvariant(set);
});

test('suggestion invariant rejects duplicate identity, invalid capability, fake enablement and silent disablement', () => {
  const mutate = (change) => {
    const set = structuredClone(creatorSuggestionSet({}, { kind: 'image' }));
    delete set.invariantReceipt;
    change(set);
    set.setDigest = digestSuggestionSet(set);
    return set;
  };
  const broken = [
    mutate((set) => { set.items[1].id = set.items[0].id; }),
    mutate((set) => { set.items[1].intent = set.items[0].intent; }),
    mutate((set) => {
      set.items[0].requiredCapabilityIds = ['missing.capability'];
      set.items[0].operationContracts = [{
        ...set.items[0].operationContracts[0],
        capabilityId: 'missing.capability',
      }];
    }),
    mutate((set) => {
      set.items[0].blockers = [{ code: 'blocked', message: '仍需核对' }];
      set.items[0].disabledReason = '仍需核对';
    }),
    mutate((set) => {
      set.items[0].executable = false;
      set.items[0].blockers = [];
      set.items[0].disabledReason = '';
      set.items[0].unblockActions = [];
    }),
    mutate((set) => {
      set.items[0].operationContracts[0].riskLevel = 'L1';
    }),
  ];
  for (const set of broken) {
    assert.throws(
      () => creatorSuggestionInvariantReceipt(set),
      (error) => error instanceof CreatorAgentSessionError
        && error.code === 'CREATOR_SUGGESTION_INVARIANT_FAILED'
        && error.statusCode === 503,
    );
  }
});
