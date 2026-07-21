import test from 'node:test';
import assert from 'node:assert/strict';
import { inferRunRecoveryDescriptor } from '../src/utils/runRecovery.ts';

test('frontend stores credential-free recovery recipes for supported provider polling', () => {
  assert.deepEqual(inferRunRecoveryDescriptor({
    provider: 'runninghub', model: 'webapp-1', taskId: 'rh-task', site: 'intl', pollLimit: 20,
  }), {
    version: 1, kind: 'runninghub', taskId: 'rh-task', model: 'webapp-1', site: 'intl',
    pollIntervalMs: 3000, maxPolls: 20,
  });
  assert.equal(inferRunRecoveryDescriptor({
    provider: 'seedance-nz', model: 'wan-2.7-spicy-i2v', taskId: 'wan-task',
  })?.kind, 'wan');
  assert.equal(inferRunRecoveryDescriptor({
    provider: 'seedance-nz', model: 'hailuo-2.3-fast-i2v', taskId: 'hailuo-task',
  })?.kind, 'hailuo');
  assert.equal(inferRunRecoveryDescriptor({
    provider: 'seedance-nz', model: 'kling-o3-pro-edit', taskId: 'kling-task',
  })?.kind, 'kling');
  assert.equal(inferRunRecoveryDescriptor({
    provider: 'seedance-nz', model: 'zhenzhen-upscaler', taskId: 'upscaler-task',
  })?.kind, 'upscaler');
  assert.equal(inferRunRecoveryDescriptor({
    provider: 'seedance-nz', model: 'vidu-q3-turbo-start-end', taskId: 'vidu-task',
  })?.kind, 'vidu');
  assert.equal(inferRunRecoveryDescriptor({
    provider: 'seedance-nz', model: 'dola-seedream-5.0-pro-t2i', taskId: 'image-task',
  })?.kind, 'seedream-nz');
  assert.equal(inferRunRecoveryDescriptor({
    provider: 'suno', model: 'v5.5', taskIds: ['a', 'b'],
  })?.kind, 'suno');
  assert.equal(inferRunRecoveryDescriptor({ provider: 'unknown', taskId: 'opaque' }), null);
});
test('explicit recovery rejects arbitrary kinds and incomplete FAL descriptors', () => {
  assert.equal(inferRunRecoveryDescriptor({ recovery: { kind: 'http', taskId: 'x', url: 'https://evil.example' } }), null);
  assert.equal(inferRunRecoveryDescriptor({ recovery: { kind: 'video-fal', requestId: 'only-request' } }), null);
  const falRecovery = inferRunRecoveryDescriptor({
    recovery: {
      kind: 'video-fal', requestId: 'req-1', responseUrl: 'https://queue.fal.run/result',
      endpoint: 'fal-ai/model', pollIntervalMs: 100, maxPolls: 9000,
    },
  });
  assert.equal(falRecovery?.pollIntervalMs, 250);
  assert.equal(Object.hasOwn(falRecovery || {}, 'responseUrl'), false);
});
