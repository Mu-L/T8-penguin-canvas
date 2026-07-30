import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CREATOR_AGENT_STARTER_IDEA_BATCH_COUNT,
  creatorAgentStarterIdeaBatch,
  creatorAgentStarterIdeaContextKey,
  creatorAgentStarterMode,
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
test('blank creator Agent starters never invent continuation context', () => {
  const context = {
    canvasRevision: 42,
    nodeCount: 18,
    edgeCount: 10,
    failedRunCount: 3,
    offscreenFailedCount: 2,
  };
  const contextKey = creatorAgentStarterIdeaContextKey(context);
  const mode = creatorAgentStarterMode(context);
  assert.equal(mode, 'blank-new');
  const forbidden = /当前|现有|这组|这个|这些|它|继续|接着|沿用|完善|补齐|只重做|恢复|检查当前/;
  for (let rotation = 0; rotation < CREATOR_AGENT_STARTER_IDEA_BATCH_COUNT; rotation += 1) {
    const batch = creatorAgentStarterIdeaBatch({
      sessionSeed: 'session-blank-1',
      contextKey,
      mode,
      rotation,
    });
    assert.equal(batch.length, 3);
    assert.equal(new Set(batch.map((item) => item.taskFamily)).size, 3);
    batch.forEach((item) => {
      assert.doesNotMatch(item.label, forbidden);
      assert.equal(item.requiredCapabilityIds.length > 0, true);
      assert.notEqual(item.starterPrompt.trim(), '');
      assert.notEqual(item.expectedFirstArtifact.trim(), '');
    });
  }
});

test('creator Agent starter mode requires explicit evidence before contextual suggestions', () => {
  assert.equal(creatorAgentStarterMode({
    nodeCount: 12,
    failedRunCount: 2,
  }), 'blank-new');
  assert.equal(creatorAgentStarterMode({
    attachmentKinds: ['image'],
    nodeCount: 12,
  }), 'attachment-ready');
  assert.equal(creatorAgentStarterMode({
    selectedNodeTypes: ['video'],
  }), 'selection-ready');
  assert.equal(creatorAgentStarterMode({
    nodeCount: 12,
    allowCanvasContext: true,
  }), 'canvas-explicit');
  assert.equal(creatorAgentStarterMode({
    failedRunCount: 2,
    allowFailureContext: true,
  }), 'recoverable-failure');
  assert.equal(creatorAgentStarterMode({
    resumedSession: true,
    selectedNodeTypes: ['video'],
  }), 'resumed-session');
});
