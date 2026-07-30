'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  advanceCreatorDecisionDocument,
  createCreatorDecisionDocument,
  creatorDecisionPromptContract,
  creatorDecisionSuggestionChoices,
  currentCreatorDecision,
  normalizeCreatorDecisionDocument,
  prepareCreatorDecisionTurn,
} = require('../backend/src/services/creatorAgentDecisions.js');

function optionSelection(document, optionIndex = 0) {
  const current = currentCreatorDecision(document);
  return {
    decisionDocumentId: document.documentId,
    decisionDocumentVersionId: document.versionId,
    decisionDocumentDigest: document.contentDigest,
    decisionId: current.id,
    decisionOptionId: current.options[optionIndex].id,
  };
}

test('decision document exposes exactly one current decision and three choices', () => {
  for (const family of ['story', 'commerce', 'image', 'video', 'audio', 'mixed']) {
    const document = createCreatorDecisionDocument({
      sessionId: `session-${family}`,
      family,
      phase: 'idea',
    });
    const current = currentCreatorDecision(document);
    const choices = creatorDecisionSuggestionChoices(document);
    assert.equal(document.status, 'collecting');
    assert.equal(current.kind, 'choice');
    assert.equal(current.status, 'pending');
    assert.equal(choices.length, 3);
    assert.deepEqual(
      choices.map((choice) => choice.decision.decisionId),
      [current.id, current.id, current.id],
    );
    assert.equal(
      document.decisions.filter((decision) => decision.status === 'pending').length,
      document.decisions.length,
    );
    const prompt = creatorDecisionPromptContract({
      document,
      currentDecision: current,
    });
    assert.match(prompt, /当前唯一待回答决策主题/);
    assert.match(prompt, /不得列出其他未来问题/);
    assert.doesNotMatch(prompt, /本阶段待确认清单/);
  }
});

test('option and custom answers advance exactly one decision and reject stale receipts', () => {
  const initial = createCreatorDecisionDocument({
    sessionId: 'session-single-decision',
    family: 'commerce',
    phase: 'idea',
  });
  const firstDecision = currentCreatorDecision(initial);
  const first = prepareCreatorDecisionTurn({
    sessionId: initial.sessionId,
    document: initial,
    family: initial.family,
    phase: initial.phase,
    selection: optionSelection(initial, 1),
  });
  assert.equal(first.answered, true);
  assert.equal(first.document.revision, initial.revision + 1);
  assert.equal(
    first.document.decisions.filter((decision) => decision.status === 'resolved').length,
    1,
  );
  assert.notEqual(first.currentDecision.id, firstDecision.id);
  assert.equal(first.currentDecision.status, 'pending');

  assert.throws(
    () => prepareCreatorDecisionTurn({
      sessionId: initial.sessionId,
      document: first.document,
      family: first.document.family,
      phase: first.document.phase,
      selection: optionSelection(initial, 0),
    }),
    /stale/,
  );

  const secondDecision = first.currentDecision;
  const second = prepareCreatorDecisionTurn({
    sessionId: initial.sessionId,
    document: first.document,
    family: first.document.family,
    phase: first.document.phase,
    customValue: '只面向已有客户复购，必须保留品牌蓝色和真实参数。',
  });
  assert.equal(second.answered, true);
  assert.notEqual(second.currentDecision.id, secondDecision.id);
  const storedSecond = second.document.decisions.find(
    (decision) => decision.id === secondDecision.id,
  );
  assert.deepEqual(storedSecond.answer, {
    source: 'custom',
    optionId: null,
    value: '只面向已有客户复购，必须保留品牌蓝色和真实参数。',
  });
});

test('stage confirmation becomes available only after all stage choices resolve', () => {
  let document = createCreatorDecisionDocument({
    sessionId: 'session-stage-confirm',
    family: 'story',
    phase: 'script',
  });
  while (currentCreatorDecision(document).kind === 'choice') {
    document = advanceCreatorDecisionDocument(document, {
      optionId: currentCreatorDecision(document).options[0].id,
    }).document;
  }
  const confirmation = currentCreatorDecision(document);
  assert.equal(document.status, 'ready-for-confirmation');
  assert.equal(confirmation.kind, 'stage-confirmation');
  assert.equal(creatorDecisionSuggestionChoices(document).length, 3);

  const revise = advanceCreatorDecisionDocument(document, {
    optionId: confirmation.options[1].id,
  });
  assert.equal(revise.advanced, false);
  assert.equal(revise.document.status, 'ready-for-confirmation');
  assert.equal(currentCreatorDecision(revise.document).id, confirmation.id);
  assert.equal(revise.document.revisionNotes.length, 1);

  const finalConfirmation = currentCreatorDecision(revise.document);
  const confirmed = advanceCreatorDecisionDocument(revise.document, {
    optionId: finalConfirmation.options[0].id,
  });
  assert.equal(confirmed.advanced, true);
  assert.equal(confirmed.document.status, 'confirmed');
  assert.equal(confirmed.document.currentDecisionId, null);
  assert.equal(currentCreatorDecision(confirmed.document), null);
  assert.ok(normalizeCreatorDecisionDocument(confirmed.document));
});

test('delivery confirmation says completion and malformed decision order fails closed', () => {
  const delivery = createCreatorDecisionDocument({
    sessionId: 'session-delivery',
    family: 'video',
    phase: 'delivery',
  });
  const confirmation = delivery.decisions.at(-1);
  assert.match(confirmation.options[0].label, /完成本次创作/);
  assert.doesNotMatch(confirmation.options[0].label, /进入下一阶段/);

  const malformed = structuredClone(delivery);
  malformed.decisions = [
    malformed.decisions.at(-1),
    ...malformed.decisions.slice(0, -1),
  ];
  assert.equal(normalizeCreatorDecisionDocument(malformed), null);
});
