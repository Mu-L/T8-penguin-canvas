'use strict';

const fs = require('node:fs');
const {
  createCreatorAgentSessionStore,
} = require('../../backend/src/services/creatorAgentSessions.js');

const [rootDir, sessionId, responseId, barrierPath] = process.argv.slice(2);
while (!fs.existsSync(barrierPath)) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
}
const store = createCreatorAgentSessionStore({ rootDir });
const result = store.completeStreamingTurn(sessionId, {
  responseId,
  context: { phase: 'story' },
  plan: {
    planId: 'plan-cross-process',
    kind: 'story',
    ready: true,
    candidateCount: 3,
    questions: [],
  },
});
process.stdout.write(JSON.stringify({
  duplicate: result.duplicate,
  eventId: result.assistantEvent.eventId,
}));

