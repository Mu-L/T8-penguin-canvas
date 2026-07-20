import test from 'node:test';
import assert from 'node:assert/strict';
import {
  collectRunOutputAssets,
  extractRunProviderTrace,
  providerTraceAttemptPatch,
} from '../src/utils/runProviderTrace.ts';

test('provider trace only accepts explicit bounded provider metadata', () => {
  const trace = extractRunProviderTrace({
    providerSource: 'seedance-nz',
    providerId: 'dola-overseas',
    providerModel: 'dola-seedream-5.0-pro-i2i',
    taskId: 'task-123',
    request_id: 'request-456',
    httpStatus: 202,
    pollCount: 7,
    usage: { credits: 1.25, nested: { totalTokens: 42 } },
  });

  assert.deepEqual(trace, {
    provider: 'dola-overseas',
    model: 'dola-seedream-5.0-pro-i2i',
    upstreamTaskId: 'task-123',
    requestId: 'request-456',
    httpStatus: 202,
    pollCount: 7,
    usage: { credits: 1.25, nested: { totalTokens: 42 } },
  });
  assert.deepEqual(providerTraceAttemptPatch(trace), {
    provider: 'dola-overseas',
    model: 'dola-seedream-5.0-pro-i2i',
    upstreamTaskId: 'task-123',
    requestId: 'request-456',
    httpStatus: 202,
    pollCount: 7,
    usage: { credits: 1.25, nested: { totalTokens: 42 } },
  });
});

test('provider trace rejects guessed ids, invalid statuses and unbounded usage', () => {
  const trace = extractRunProviderTrace({
    id: 'must-not-be-guessed-as-task',
    provider: { id: 'object-must-not-stringify' },
    status: 'success',
    httpStatus: 999,
    pollCount: -5,
    usage: { authorization: 'secret', huge: 'x'.repeat(9000) },
  });
  assert.deepEqual(trace, {
    pollCount: 0,
    usage: { authorization: '[redacted]', huge: `${'x'.repeat(4000)}…` },
  });
});

test('output extraction produces deduplicated media and text AssetRef candidates without base64', () => {
  const outputs = collectRunOutputAssets({
    imageUrl: '/files/output/a.png',
    imageUrls: ['/files/output/a.png', 'https://cdn.example/b.webp'],
    videoUrl: '/files/output/c.mp4',
    audioUrls: ['data:audio/mp3;base64,AAAA', '/files/output/d.mp3'],
    modelUrl: '/files/output/e.glb',
    outputText: 'final answer',
    prompt: 'input prompt must not become an output',
  });

  assert.deepEqual(outputs.map((item) => item.kind), ['image', 'image', 'video', 'audio', 'model3d', 'text']);
  assert.deepEqual(outputs.map((item) => item.sourceUrl || item.text), [
    '/files/output/a.png',
    'https://cdn.example/b.webp',
    '/files/output/c.mp4',
    '/files/output/d.mp3',
    '/files/output/e.glb',
    'final answer',
  ]);
  assert.equal(outputs.some((item) => String(item.sourceUrl || '').startsWith('data:')), false);
});
