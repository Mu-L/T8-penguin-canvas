import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  queryVideo,
  queryVideoFal,
} from '../src/services/generation.ts';
import { normalizeProviderErrorMessage } from '../src/utils/providerErrorMessage.ts';

const read = (relativePath: string) => readFileSync(new URL(relativePath, import.meta.url), 'utf8');

test('provider error messages safely normalize structured and nested failures', () => {
  assert.equal(
    normalizeProviderErrorMessage({ message: 'Provider failed', code: 'provider_error' }, '生成失败'),
    'Provider failed',
  );
  assert.equal(
    normalizeProviderErrorMessage({ error: { detail: '额度不足', code: 'quota_exhausted' } }, '生成失败'),
    '额度不足',
  );
  assert.equal(normalizeProviderErrorMessage({ code: 'provider_error' }, '生成失败'), 'provider_error');
  assert.equal(normalizeProviderErrorMessage({ arbitrary: 'must not be rendered' }, '生成失败'), '生成失败');

  const cyclic: Record<string, unknown> = {};
  cyclic.error = cyclic;
  assert.equal(normalizeProviderErrorMessage(cyclic, '生成失败'), '生成失败');
});

test('video query services convert object-shaped provider failures to strings', async () => {
  const originalFetch = globalThis.fetch;
  const responses = [
    {
      success: false,
      data: { status: 'failed', error: { message: 'FAL provider failed', code: 'provider_error' } },
    },
    {
      success: true,
      data: { status: 'FAILURE', failReason: { message: 'Video provider failed', code: 'provider_error' } },
    },
  ];
  globalThis.fetch = (async () => new Response(JSON.stringify(responses.shift()), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })) as typeof fetch;

  try {
    const fal = await queryVideoFal({ requestId: 'request-1', endpoint: 'fal/test' });
    const standard = await queryVideo('task-1', 'video-model');
    assert.equal(fal.error, 'FAL provider failed');
    assert.equal(typeof fal.error, 'string');
    assert.equal(standard.failReason, 'Video provider failed');
    assert.equal(typeof standard.failReason, 'string');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('video query transport errors keep structured provider messages and HTTP trace', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({
    success: false,
    error: { message: 'Provider gateway failed', code: 'provider_error' },
  }), {
    status: 502,
    headers: { 'content-type': 'application/json', 'x-request-id': 'request-502' },
  })) as typeof fetch;

  try {
    await assert.rejects(
      () => queryVideoFal({ requestId: 'request-1', endpoint: 'fal/test' }),
      (error: unknown) => {
        const failure = error as Error & Record<string, unknown>;
        assert.equal(failure.message, 'Provider gateway failed');
        assert.equal(failure.transportHttpStatus, 502);
        assert.equal(failure.requestId, 'request-502');
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('VideoNode normalizes polling, submission and render-boundary errors', () => {
  const source = read('../src/components/nodes/VideoNode.tsx');
  assert.match(source, /normalizeProviderErrorMessage\(r\.failReason, '生成失败'\)/);
  assert.match(source, /normalizeProviderErrorMessage\(r\.error, 'FAL 生成失败'\)/);
  assert.match(source, /normalizeProviderErrorMessage\(e, '提交失败'\)/);
  assert.match(source, /\{normalizeProviderErrorMessage\(error, '生成失败'\)\}/);
});
