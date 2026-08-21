const test = require('node:test');
const assert = require('node:assert/strict');
const { deriveRunIntentAuthority } = require('../backend/src/collaboration/runIntentAuthority');

function documentFor(data = {}) {
  return {
    nodes: [{ id: 'music3-enhancer', type: 'minimax-music3-prompt-enhancer', position: { x: 0, y: 0 }, data }],
    edges: [],
  };
}

test('MiniMax Music 3 authority defaults to the verified Seedance 2.1 Pro LLM', () => {
  const authority = deriveRunIntentAuthority(documentFor(), ['music3-enhancer']);
  assert.deepEqual(authority.declarations, [{
    provider: 'seedance-nz',
    model: 'bytedance/doubao-seed-2.1-pro',
    nodeIds: ['music3-enhancer'],
  }]);
});

test('MiniMax Music 3 authority preserves built-in workshop and fails closed for host extensions', () => {
  const authority = deriveRunIntentAuthority(documentFor({ llmApiSource: 'zhenzhen', providerSource: 'zhenzhen', model: 'gemini-3.5-flash' }), ['music3-enhancer']);
  assert.deepEqual(authority.declarations, [{ provider: 'zhenzhen', model: 'gemini-3.5-flash', nodeIds: ['music3-enhancer'] }]);
  assert.throws(
    () => deriveRunIntentAuthority(documentFor({ providerSource: 'openai-compatible', providerId: 'custom-openai', providerModel: 'custom-model' }), ['music3-enhancer']),
    (error) => error?.code === 'intent_external_provider_authority_unavailable',
  );
});
