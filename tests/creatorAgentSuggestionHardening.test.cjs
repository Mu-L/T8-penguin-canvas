'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

const {
  CreatorAgentSessionError,
  createCreatorAgentSessionStore,
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

function resign(set) {
  set.setDigest = crypto.createHash('sha256').update(stableString({
    schema: set.schema,
    binding: set.binding,
    items: set.items,
  })).digest('hex');
  delete set.invariantReceipt;
  return set;
}

function assertInvariantFailure(set) {
  assert.throws(
    () => creatorSuggestionInvariantReceipt(set),
    (error) => error instanceof CreatorAgentSessionError
      && error.code === 'CREATOR_SUGGESTION_INVARIANT_FAILED'
      && error.statusCode === 503,
  );
}

function runWorker(rootDir, sessionId, responseId, barrierPath) {
  const worker = path.join(__dirname, 'fixtures', 'creatorAgentCompleteWorker.cjs');
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [worker, rootDir, sessionId, responseId, barrierPath],
      { encoding: 'utf8', timeout: 15_000 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`${error.message}\n${stderr}`));
          return;
        }
        resolve(JSON.parse(stdout));
      },
    );
  });
}

test('SuggestionSet contracts match authoritative operations field for field', () => {
  const changes = [
    (set) => { set.items[0].operationContracts[0].operation = 'not-real'; },
    (set) => { set.items[0].operationContracts[0].boundary = 'not-authoritative'; },
    (set) => { set.items[0].operationContracts[0].requiredScopes = ['canvas:write']; },
    (set) => { set.items[0].operationContracts[0].requiredScopes.push('canvas:read'); },
    (set) => {
      set.items[0].executable = false;
      set.items[0].blockers = [{}];
      set.items[0].disabledReason = '';
      set.items[0].unblockActions = [''];
    },
    (set) => {
      set.items[0].unblockActions = ['先处理一个不存在的阻断'];
    },
  ];
  for (const change of changes) {
    const set = structuredClone(creatorSuggestionSet({}, { kind: 'image' }));
    change(set);
    assertInvariantFailure(resign(set));
  }
});
test('versioned suggestion evidence is revalidated when reading snapshot and event history', (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 't8-creator-suggestion-corrupt-'));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const store = createCreatorAgentSessionStore({ rootDir });
  const created = store.create({
    projectId: 'project-local',
    canvasId: 'canvas-corrupt',
    context: { nodeCount: 0, edgeCount: 0 },
  });
  const snapshotPath = path.join(rootDir, 'sessions', `${created.id}.json`);
  const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
  snapshot.suggestionSet.invariantReceipt.suggestionSetCount = 2;
  fs.writeFileSync(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  assert.throws(
    () => store.read(created.id),
    (error) => error instanceof CreatorAgentSessionError
      && error.code === 'CREATOR_SESSION_CORRUPT',
  );
  assert.throws(
    () => store.eventsAfter(created.id, 0, 100),
    (error) => error instanceof CreatorAgentSessionError
      && error.code === 'CREATOR_SESSION_CORRUPT',
  );
});

test('two local processes completing the same response persist one terminal SuggestionSet', async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 't8-creator-suggestion-race-'));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const store = createCreatorAgentSessionStore({ rootDir });
  const created = store.create({
    projectId: 'project-local',
    canvasId: 'canvas-cross-process',
    context: { nodeCount: 0, edgeCount: 0 },
  });
  const plan = {
    planId: 'plan-cross-process',
    kind: 'story',
    ready: true,
    candidateCount: 3,
    questions: [],
  };
  const begun = store.beginStreamingTurn(created.id, {
    text: '一句话做一个短片',
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

  const barrierPath = path.join(rootDir, 'start-complete');
  const firstPromise = runWorker(rootDir, created.id, begun.responseId, barrierPath);
  const secondPromise = runWorker(rootDir, created.id, begun.responseId, barrierPath);
  await new Promise((resolve) => setTimeout(resolve, 80));
  fs.writeFileSync(barrierPath, 'go', 'utf8');
  const results = await Promise.all([firstPromise, secondPromise]);
  assert.deepEqual(results.map((result) => result.duplicate).sort(), [false, true]);
  assert.equal(new Set(results.map((result) => result.eventId)).size, 1);

  const recovered = createCreatorAgentSessionStore({ rootDir }).read(created.id);
  const completed = recovered.events.filter((event) => (
    event.type === 'assistant.response.completed'
    && event.payload?.responseId === begun.responseId
  ));
  assert.equal(completed.length, 1);
  assert.equal(completed[0].payload.suggestionSet.items.length, 3);
  assert.equal(completed[0].payload.suggestionInvariantReceipt.suggestionSetCount, 1);
  const sequences = recovered.events.map((event) => event.sequence);
  assert.equal(new Set(sequences).size, sequences.length);
  assert.deepEqual(sequences, sequences.slice().sort((left, right) => left - right));
});
