const test = require('node:test');
const assert = require('node:assert/strict');
const {
  deriveRunIntentAuthority,
} = require('../backend/src/collaboration/runIntentAuthority');

function documentFor(data = {}) {
  return {
    nodes: [{
      id: 'h3-enhancer',
      type: 'minimax-h3-prompt-enhancer',
      position: { x: 0, y: 0 },
      data,
    }],
    edges: [],
  };
}

test('MiniMax H3 authority defaults to 贞贞平价小屋 Seedance 2.1 Pro', () => {
  const authority = deriveRunIntentAuthority(documentFor(), ['h3-enhancer']);
  assert.deepEqual(authority.declarations, [{
    provider: 'seedance-nz',
    model: 'bytedance/doubao-seed-2.1-pro',
    nodeIds: ['h3-enhancer'],
  }]);
});

test('MiniMax H3 authority preserves the built-in 贞贞工坊 model', () => {
  const authority = deriveRunIntentAuthority(documentFor({
    llmApiSource: 'zhenzhen',
    providerSource: 'zhenzhen',
    model: 'gemini-3.5-flash',
  }), ['h3-enhancer']);
  assert.deepEqual(authority.declarations, [{
    provider: 'zhenzhen',
    model: 'gemini-3.5-flash',
    nodeIds: ['h3-enhancer'],
  }]);
});

test('MiniMax H3 remote authority fails closed for host-configured extension providers', () => {
  assert.throws(
    () => deriveRunIntentAuthority(documentFor({
      providerSource: 'openai-compatible',
      providerId: 'custom-openai',
      providerModel: 'custom-vision-model',
    }), ['h3-enhancer']),
    (error) => error?.code === 'intent_external_provider_authority_unavailable',
  );
});
