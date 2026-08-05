const test = require('node:test');
const assert = require('node:assert/strict');
const { deriveRunIntentAuthority } = require('../backend/src/collaboration/runIntentAuthority');

function documentFor(data = {}) {
  return {
    nodes: [{
      id: 'seedance20-enhancer',
      type: 'seedance20-prompt-enhancer',
      position: { x: 0, y: 0 },
      data,
    }],
    edges: [],
  };
}

test('Seedance 2.0 enhancer authority defaults to 贞贞平价小屋 Seedance 2.1 Pro', () => {
  const authority = deriveRunIntentAuthority(documentFor(), ['seedance20-enhancer']);
  assert.deepEqual(authority.declarations, [{
    provider: 'seedance-nz',
    model: 'bytedance/doubao-seed-2.1-pro',
    nodeIds: ['seedance20-enhancer'],
  }]);
});

test('Seedance 2.0 enhancer authority preserves built-in workshop and fails closed for host extensions', () => {
  const authority = deriveRunIntentAuthority(documentFor({
    llmApiSource: 'zhenzhen',
    providerSource: 'zhenzhen',
    model: 'gemini-3.5-flash',
  }), ['seedance20-enhancer']);
  assert.deepEqual(authority.declarations, [{
    provider: 'zhenzhen',
    model: 'gemini-3.5-flash',
    nodeIds: ['seedance20-enhancer'],
  }]);
  assert.throws(
    () => deriveRunIntentAuthority(documentFor({
      providerSource: 'openai-compatible',
      providerId: 'custom-openai',
      providerModel: 'custom-vision-model',
    }), ['seedance20-enhancer']),
    (error) => error?.code === 'intent_external_provider_authority_unavailable',
  );
});
