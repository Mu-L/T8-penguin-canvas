import assert from 'node:assert/strict';
import test from 'node:test';
import {
  queryHailuo,
  queryImageFal,
  queryImageStatus,
  querySeedance,
  querySeedreamNz,
  submitHailuo,
  submitImageAsync,
  submitImageFal,
  submitSeedance,
  submitSeedreamNz,
} from '../src/services/generation.ts';

test('every MV image/video submit and poll transport forwards the exact parent AbortSignal', async () => {
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  const calls: Array<{ url: string; signal?: AbortSignal | null }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, signal: init?.signal });
    let data: Record<string, unknown> = { success: true, data: { status: 'completed', progress: '100%', urls: ['https://example.invalid/result.png'] } };
    if (url.includes('/hailuo/submit')) data = { success: true, data: { taskId: 'hailuo-task', taskProvider: 'seedance-nz', model: 'hailuo-h3-multi', taskType: 'multi' } };
    if (url.includes('/seedance/submit')) data = { success: true, data: { taskId: 'seedance-task', taskProvider: 'seedance-nz', model: 'fast', taskType: 'i2v' } };
    if (url.includes('/image/fal/submit')) data = { success: true, data: { sync: false, requestId: 'fal-task', endpoint: 'fal-endpoint' } };
    if (url.includes('/image/submit') || url.includes('/seedance-nz/submit')) data = { success: true, data: { sync: false, taskId: 'image-task', status: 'pending', progress: '0%' } };
    if (url.includes('/seedance/query')) data = { success: true, data: { status: 'succeeded', videoUrl: 'https://example.invalid/result.mp4' } };
    return new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try {
    const transport = { signal: controller.signal, submissionKey: 't8-mv-test-abort-signal' };
    await submitImageAsync({ prompt: 'p', model: 'gpt-image-2' } as any, transport);
    await queryImageStatus('image-task', 'gpt-image-2', transport);
    await submitSeedreamNz({ prompt: 'p', model: 'zhenzhen-image-g2-t2i' }, transport);
    await querySeedreamNz('image-task', transport);
    await submitImageFal({ prompt: 'p', model: 'gpt-image-2-fal' } as any, transport);
    await queryImageFal({ endpoint: 'fal-endpoint', requestId: 'fal-task' }, transport);
    const hailuoSubmission = await submitHailuo({ model: 'hailuo-h3-multi', duration: 5, ratio: '16:9', resolution: '720p', prompt: 'p' }, transport);
    assert.deepEqual({ taskProvider: hailuoSubmission.taskProvider, model: hailuoSubmission.model, taskType: hailuoSubmission.taskType }, { taskProvider: 'seedance-nz', model: 'hailuo-h3-multi', taskType: 'multi' });
    await queryHailuo('hailuo-task', transport);
    await submitSeedance({ model: 'fast', prompt: 'p', duration: 5, taskProvider: 'seedance-nz' } as any, transport);
    await querySeedance('seedance-task', 'seedance-nz', transport);
    assert.equal(calls.length, 10);
    assert.equal(calls.every((call) => call.signal === controller.signal), true, calls.map((call) => call.url).join('\n'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
