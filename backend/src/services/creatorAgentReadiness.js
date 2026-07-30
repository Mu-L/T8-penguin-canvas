'use strict';

const CREATOR_AGENT_READINESS_SCHEMA = 't8-creator-agent-local-readiness-receipt-v1';
const CREATOR_AGENT_SHELL_TARGET_MS = 300;
const CREATOR_AGENT_LOCAL_PLAN_TARGET_MS = 2_000;

function monotonicNowMs() {
  return Number(process.hrtime.bigint()) / 1_000_000;
}

function roundedMilliseconds(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0
    ? Math.round(number * 1_000) / 1_000
    : 0;
}

function createCreatorAgentLocalReadinessReceipt(input = {}) {
  const startedAtMs = Number(input.startedAtMs);
  const readyAtMs = Number(input.readyAtMs);
  const localPlanMs = roundedMilliseconds(readyAtMs - startedAtMs);
  return {
    schema: CREATOR_AGENT_READINESS_SCHEMA,
    measurement: 'server-monotonic-local-planner',
    localPlanMs,
    targetMs: CREATOR_AGENT_LOCAL_PLAN_TARGET_MS,
    withinTarget: localPlanMs <= CREATOR_AGENT_LOCAL_PLAN_TARGET_MS,
    sideEffects: {
      providerCalls: 0,
      canvasWrites: 0,
      productionFileWrites: 0,
    },
  };
}

function percentile95(values = []) {
  const samples = values
    .map(roundedMilliseconds)
    .filter((value) => Number.isFinite(value))
    .sort((left, right) => left - right);
  if (samples.length === 0) return 0;
  return samples[Math.max(0, Math.ceil(samples.length * 0.95) - 1)];
}

module.exports = {
  CREATOR_AGENT_READINESS_SCHEMA,
  CREATOR_AGENT_SHELL_TARGET_MS,
  CREATOR_AGENT_LOCAL_PLAN_TARGET_MS,
  monotonicNowMs,
  createCreatorAgentLocalReadinessReceipt,
  percentile95,
};
