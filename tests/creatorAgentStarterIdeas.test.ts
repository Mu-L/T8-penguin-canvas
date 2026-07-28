import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CREATOR_AGENT_STARTER_IDEA_BATCH_COUNT,
  creatorAgentStarterIdeaBatch,
  creatorAgentStarterIdeaContextKey,
} from '../src/utils/creatorAgentStarterIdeas.ts';

test('creator Agent starter ideas stay stable for the same session and canvas context', () => {
  const contextKey = creatorAgentStarterIdeaContextKey({
    canvasRevision: 42,
    nodeCount: 6,
    edgeCount: 5,
    selectedNodeTypes: ['video', 'image', 'video'],
    referencedNodeTypes: ['story'],
    failedRunCount: 1,
    offscreenFailedCount: 2,
  });
  const input = { sessionSeed: 'session-stable-1', contextKey, rotation: 0 };
  assert.deepEqual(
    creatorAgentStarterIdeaBatch(input),
    creatorAgentStarterIdeaBatch(input),
  );
  assert.match(contextKey, /^[0-9a-f]{8}$/);
});

test('creator Agent starter ideas rotate four complete batches without duplicates', () => {
  const contextKey = creatorAgentStarterIdeaContextKey({
    canvasRevision: 7,
    nodeCount: 3,
    edgeCount: 2,
  });
  const batches = Array.from(
    { length: CREATOR_AGENT_STARTER_IDEA_BATCH_COUNT },
    (_, rotation) => creatorAgentStarterIdeaBatch({
      sessionSeed: 'session-rotation-1',
      contextKey,
      rotation,
    }),
  );
  batches.forEach((batch) => {
    assert.equal(batch.length, 3);
    assert.equal(new Set(batch.map((item) => item.id)).size, 3);
    assert.equal(new Set(batch.map((item) => item.label)).size, 3);
  });
  assert.equal(
    new Set(batches.flat().map((item) => item.id)).size,
    CREATOR_AGENT_STARTER_IDEA_BATCH_COUNT * 3,
  );
  assert.deepEqual(
    creatorAgentStarterIdeaBatch({
      sessionSeed: 'session-rotation-1',
      contextKey,
      rotation: CREATOR_AGENT_STARTER_IDEA_BATCH_COUNT,
    }),
    batches[0],
  );
});

test('creator Agent starter context key is canonical and accepts only bounded structural facts', () => {
  const first = creatorAgentStarterIdeaContextKey({
    canvasRevision: 9,
    nodeCount: 4,
    edgeCount: 3,
    selectedNodeTypes: ['video', 'image', 'video'],
    referencedNodeTypes: ['text', 'story'],
    failedRunCount: 1,
    offscreenFailedCount: 0,
  });
  const reordered = creatorAgentStarterIdeaContextKey({
    canvasRevision: 9,
    nodeCount: 4,
    edgeCount: 3,
    selectedNodeTypes: ['image', 'video'],
    referencedNodeTypes: ['story', 'text'],
    failedRunCount: 1,
    offscreenFailedCount: 0,
  });
  const changed = creatorAgentStarterIdeaContextKey({
    canvasRevision: 10,
    nodeCount: 4,
    edgeCount: 3,
    selectedNodeTypes: ['image', 'video'],
    referencedNodeTypes: ['story', 'text'],
    failedRunCount: 1,
    offscreenFailedCount: 0,
  });
  assert.equal(first, reordered);
  assert.notEqual(first, changed);
});
