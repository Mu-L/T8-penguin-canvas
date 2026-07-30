'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CREATOR_AGENT_READINESS_SCHEMA,
  CREATOR_AGENT_LOCAL_PLAN_TARGET_MS,
  createCreatorAgentLocalReadinessReceipt,
  percentile95,
} = require('../backend/src/services/creatorAgentReadiness.js');

test('local readiness receipt uses a monotonic duration and records zero production side effects', () => {
  const receipt = createCreatorAgentLocalReadinessReceipt({
    startedAtMs: 100.125,
    readyAtMs: 345.678,
  });
  assert.deepEqual(receipt, {
    schema: CREATOR_AGENT_READINESS_SCHEMA,
    measurement: 'server-monotonic-local-planner',
    localPlanMs: 245.553,
    targetMs: CREATOR_AGENT_LOCAL_PLAN_TARGET_MS,
    withinTarget: true,
    sideEffects: {
      providerCalls: 0,
      canvasWrites: 0,
      productionFileWrites: 0,
    },
  });
});

test('p95 uses nearest-rank over bounded millisecond samples', () => {
  const samples = Array.from({ length: 20 }, (_, index) => index + 1);
  assert.equal(percentile95(samples), 19);
  assert.equal(percentile95([2.3456, 1.2345]), 2.346);
  assert.equal(percentile95([]), 0);
});

test('receipt fails the target visibly instead of hiding an over-budget local plan', () => {
  const receipt = createCreatorAgentLocalReadinessReceipt({
    startedAtMs: 0,
    readyAtMs: CREATOR_AGENT_LOCAL_PLAN_TARGET_MS + 0.5,
  });
  assert.equal(receipt.withinTarget, false);
  assert.equal(receipt.localPlanMs, 2000.5);
});
