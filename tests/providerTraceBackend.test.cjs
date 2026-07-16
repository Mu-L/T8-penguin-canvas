const test = require('node:test');
const assert = require('node:assert/strict');

const {
  mergeProviderTrace,
  providerTrace,
} = require('../backend/src/providers/providerTrace');
const openaiCompatible = require('../backend/src/providers/openaiCompatible');
const modelscope = require('../backend/src/providers/modelscope');
const seedanceNz = require('../backend/src/providers/seedanceNz');

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

test('backend provider trace uses explicit request ids, real status, bounded usage and no generic id guessing', () => {
  const trace = providerTrace(
    jsonResponse({}, 201, { 'x-request-id': 'req-header-1' }),
    {
      id: 'must-not-become-request-id',
      usage: {
        total_tokens: 19,
        nested: { apiKey: 'secret-value', completion_tokens: 7 },
      },
    },
    { pollCount: 2 },
  );
  assert.deepEqual(trace, {
    upstreamHttpStatus: 201,
    requestId: 'req-header-1',
    usage: {
      total_tokens: 19,
      nested: { apiKey: '[redacted]', completion_tokens: 7 },
    },
    pollCount: 2,
  });
  assert.equal(providerTrace(null, { id: 'generic-id' }).requestId, undefined);
});

test('backend provider trace preserves submit request id while taking latest real status and maximum poll count', () => {
  assert.deepEqual(
    mergeProviderTrace(
      { requestId: 'submit-request', upstreamHttpStatus: 202, pollCount: 0 },
      { requestId: 'poll-request', upstreamHttpStatus: 200, pollCount: 3, usage: { total_tokens: 9 } },
    ),
    {
      requestId: 'submit-request',
      upstreamHttpStatus: 200,
      pollCount: 3,
      usage: { total_tokens: 9 },
    },
  );
});

test('OpenAI-compatible adapter returns explicit upstream request, HTTP, usage and direct poll count', async () => {
  const result = await openaiCompatible.generateChat({
    id: 'openai-fixture',
    protocol: 'openai-compatible',
    baseUrl: 'https://provider.example/v1',
    apiKey: 'test-key',
    chatModels: ['fixture-chat'],
  }, {
    prompt: 'hello',
  }, {
    fetchImpl: async () => jsonResponse({
      id: 'chat-completion-id-is-not-request-id',
      choices: [{ message: { content: 'world' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
    }, 200, { 'x-request-id': 'req-openai-1' }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.requestId, 'req-openai-1');
  assert.equal(result.upstreamHttpStatus, 200);
  assert.equal(result.pollCount, 0);
  assert.deepEqual(result.usage, { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 });
});

test('ModelScope adapter records the actual failed poll request without replacing submit request id', async () => {
  const responses = [
    jsonResponse({ task_id: 'modelscope-task-1' }, 202, { 'x-request-id': 'req-submit-1' }),
    jsonResponse({ message: 'rate limited' }, 429, { 'x-request-id': 'req-poll-1' }),
  ];
  const result = await modelscope.generateImage({
    id: 'modelscope',
    protocol: 'modelscope',
    baseUrl: 'https://api-inference.modelscope.cn/v1',
    apiKey: 'test-key',
    imageModels: ['fixture-image'],
  }, {
    prompt: 'fixture',
  }, {
    fetchImpl: async () => responses.shift(),
    pollIntervalMs: 1,
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'http_error');
  assert.equal(result.taskId, 'modelscope-task-1');
  assert.equal(result.requestId, 'req-submit-1');
  assert.equal(result.upstreamHttpStatus, 429);
  assert.equal(result.pollCount, 1);
});

test('seedance.nz submit and query expose only explicit upstream trace fields', async () => {
  const responses = [
    jsonResponse({ id: 'video-task-1', status: 'queued' }, 201, { 'x-request-id': 'req-seedance-submit' }),
    jsonResponse({ status: 'completed', metadata: { url: 'https://cdn.example/result.mp4' }, usage: { credits: 4 } }, 200, { 'x-request-id': 'req-seedance-query' }),
  ];
  const fetchImpl = async () => responses.shift();
  const submitted = await seedanceNz.submitTask({
    model: 'mini',
    prompt: 'a small bird flying over water',
    duration: 4,
    ratio: '16:9',
    resolution: '480p',
  }, 'test-key', { baseUrl: 'https://api.seedance.nz', fetchImpl });
  const queried = await seedanceNz.queryTask(submitted.taskId, 'test-key', {
    baseUrl: 'https://api.seedance.nz',
    fetchImpl,
  });

  assert.equal(submitted.taskId, 'video-task-1');
  assert.equal(submitted.requestId, 'req-seedance-submit');
  assert.equal(submitted.upstreamHttpStatus, 201);
  assert.equal(submitted.pollCount, 0);
  assert.equal(queried.requestId, 'req-seedance-query');
  assert.equal(queried.upstreamHttpStatus, 200);
  assert.deepEqual(queried.usage, { credits: 4 });
});
