'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createCreatorAgentSessionStore,
  creatorSuggestionInvariantReceipt,
} = require('../backend/src/services/creatorAgentSessions.js');

test('one logical assistant completion persists exactly one three-item SuggestionSet receipt', (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 't8-creator-suggestion-completion-'));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const store = createCreatorAgentSessionStore({ rootDir });
  const created = store.create({
    projectId: 'project-local',
    canvasId: 'canvas-suggestion-invariant',
    context: { nodeCount: 0, edgeCount: 0 },
  });
  const plan = {
    planId: 'plan-suggestion-invariant',
    kind: 'story',
    ready: true,
    candidateCount: 3,
    questions: [],
  };
  const begun = store.beginStreamingTurn(created.id, {
    text: '一句话做一个雨夜短片',
    context: { phase: 'story' },
    plan,
  });
  begun.chunks.forEach((delta, index) => {
    store.appendResponseDelta(created.id, {
      responseId: begun.responseId,
      index,
      delta,
    });
  });
  const first = store.completeStreamingTurn(created.id, {
    responseId: begun.responseId,
    context: { phase: 'story' },
    plan,
  });
  const duplicate = store.completeStreamingTurn(created.id, {
    responseId: begun.responseId,
    context: { phase: 'story' },
    plan,
  });
  assert.equal(first.duplicate, false);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.assistantEvent.eventId, first.assistantEvent.eventId);

  const recovered = createCreatorAgentSessionStore({ rootDir }).read(created.id);
  const completed = recovered.events.filter((event) => (
    event.type === 'assistant.response.completed'
    && event.payload?.responseId === begun.responseId
  ));
  assert.equal(completed.length, 1);
  assert.equal(Object.hasOwn(completed[0].payload, 'suggestionSet'), true);
  assert.equal(
    Object.keys(completed[0].payload).filter((key) => key === 'suggestionSet').length,
    1,
  );
  const set = completed[0].payload.suggestionSet;
  assert.equal(set.items.length, 3);
  assert.equal(new Set(set.items.map((item) => item.id)).size, 3);
  assert.equal(new Set(set.items.map((item) => item.intent)).size, 3);
  assert.deepEqual(set.invariantReceipt, creatorSuggestionInvariantReceipt(set));
  assert.deepEqual(
    completed[0].payload.suggestionInvariantReceipt,
    set.invariantReceipt,
  );
  assert.equal(set.invariantReceipt.fakeEnabledActionCount, 0);
  assert.equal(set.invariantReceipt.unexplainedDisabledActionCount, 0);
});
