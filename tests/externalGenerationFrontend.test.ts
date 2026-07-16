import test from 'node:test';
import assert from 'node:assert/strict';

import {
  generateExternalImage,
  generateExternalVideo,
  generateExternalLlm,
} from '../src/services/generation.ts';

function jsonResponse(body: any, status = 200, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name: string) {
        return headers[String(name).toLowerCase()] || null;
      },
    },
    async json() {
      return body;
    },
  } as any;
}

test('generateExternalImage posts to external image route and returns normalized image urls', async () => {
  const calls: any[] = [];
  const oldFetch = globalThis.fetch;
  (globalThis as any).fetch = async (url: string, init: any) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return jsonResponse({
      success: true,
      data: {
        imageUrls: ['/files/output/external_1.png'],
        remoteImageUrls: ['https://cdn.example.com/raw.png'],
        provider: { id: 'modelscope', protocol: 'modelscope' },
      },
    });
  };
  try {
    const result = await generateExternalImage({
      providerId: 'modelscope',
      prompt: 'draw',
      model: 'flux-dev',
      size: '1024x1024',
      images: ['/files/input/a.png'],
    });

    assert.equal(calls[0].url, '/api/proxy/external/image');
    assert.equal(calls[0].body.providerId, 'modelscope');
    assert.equal(calls[0].body.model, 'flux-dev');
    assert.deepEqual(result.imageUrls, ['/files/output/external_1.png']);
    assert.deepEqual(result.remoteImageUrls, ['https://cdn.example.com/raw.png']);
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test('generateExternalLlm posts to external llm route and maps text to content', async () => {
  const oldFetch = globalThis.fetch;
  (globalThis as any).fetch = async (url: string, init: any) => {
    assert.equal(url, '/api/proxy/external/llm');
    const body = JSON.parse(init.body);
    assert.equal(body.providerId, 'openai-compatible');
    assert.equal(body.model, 'gpt-4o-mini');
    assert.equal(body.llmVideoMode, 'url');
    assert.equal(body.messages[0].content[1].type, 'video_url');
    return jsonResponse({
      success: true,
      data: {
        text: 'hello external',
        raw: { ok: true },
        provider: { id: 'openai-compatible', protocol: 'openai-compatible' },
      },
    });
  };
  try {
    const result = await generateExternalLlm({
      providerId: 'openai-compatible',
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }, { type: 'video_url', video_url: { url: '/files/output/demo.mp4' } }] }],
      llmVideoMode: 'url',
    });

    assert.equal(result.content, 'hello external');
    assert.deepEqual(result.raw, { ok: true });
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test('generateExternalVideo posts to external video route and returns normalized video urls', async () => {
  const calls: any[] = [];
  const oldFetch = globalThis.fetch;
  (globalThis as any).fetch = async (url: string, init: any) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return jsonResponse({
      success: true,
      data: {
        videoUrls: ['/files/output/external_1.mp4'],
        remoteVideoUrls: ['https://cdn.example.com/raw.mp4'],
        taskId: 'vid-1',
        provider: { id: 'volcengine', protocol: 'volcengine' },
      },
    });
  };
  try {
    const result = await generateExternalVideo({
      providerId: 'volcengine',
      prompt: 'pass',
      model: 'seedance',
      aspect_ratio: '16:9',
      duration: 5,
      resolution: '720p',
      images: ['/files/input/a.png'],
    });

    assert.equal(calls[0].url, '/api/proxy/external/video');
    assert.equal(calls[0].body.providerId, 'volcengine');
    assert.equal(calls[0].body.model, 'seedance');
    assert.deepEqual(result.videoUrls, ['/files/output/external_1.mp4']);
    assert.deepEqual(result.remoteVideoUrls, ['https://cdn.example.com/raw.mp4']);
    assert.equal(result.taskId, 'vid-1');
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test('provider generation exposes explicit transport/request/usage metadata without guessing generic ids', async () => {
  const oldFetch = globalThis.fetch;
  (globalThis as any).fetch = async () => jsonResponse({
    success: true,
    data: {
      id: 'generic-id-must-not-become-request-id',
      videoUrls: ['/files/output/traced.mp4'],
      upstreamHttpStatus: 201,
      usage: { credits: 2, totalTokens: 42 },
    },
  }, 202, { 'x-request-id': 'request-from-header' });
  try {
    const result = await generateExternalVideo({ providerId: 'trace-provider', prompt: 'trace', model: 'trace-model' });
    assert.equal(result.requestId, 'request-from-header');
    assert.equal(result.transportHttpStatus, 202);
    assert.equal(result.upstreamHttpStatus, 201);
    assert.deepEqual(result.usage, { credits: 2, totalTokens: 42 });
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test('provider HTTP failures retain transport status and request id for NormalizedRunError', async () => {
  const oldFetch = globalThis.fetch;
  (globalThis as any).fetch = async () => jsonResponse({ success: false, error: 'rate limited' }, 429, {
    'x-request-id': 'request-rate-limit',
  });
  try {
    await assert.rejects(
      () => generateExternalImage({ providerId: 'trace-provider', prompt: 'trace' }),
      (error: any) => {
        assert.equal(error.transportHttpStatus, 429);
        assert.equal(error.status, 429);
        assert.equal(error.requestId, 'request-rate-limit');
        return true;
      },
    );
  } finally {
    globalThis.fetch = oldFetch;
  }
});
