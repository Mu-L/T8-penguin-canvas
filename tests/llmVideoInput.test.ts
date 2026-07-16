import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { generateLlmStream } from '../src/services/generation.ts';
import { assertProductionNodeSchema } from './helpers/canvasNodeSchema.ts';

const require = createRequire(import.meta.url);
const { normalizeLlmMessageMedia, resolveBundledFfmpeg } = require('../backend/src/providers/llmMedia.js');

const ROOT = path.resolve(process.cwd());

function read(rel: string) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf-8');
}

test('LLM node accepts video ports and builds video_url payloads', () => {
  const node = read('src/components/nodes/LLMNode.tsx');
  const generation = read('src/services/generation.ts');

  assertProductionNodeSchema('llm', {
    label: 'LLM',
    category: 'core',
    inputs: ['text', 'image', 'video'],
    outputs: ['text'],
    executable: true,
  });
  assert.match(generation, /type:\s*'video_url'/);
  assert.match(node, /video_url:\s*\{\s*url:\s*u\s*\}/);
  assert.match(node, /groups=\{\['text', 'image', 'video'\]\}/);
  assert.match(node, /accepts:\s*\['image', 'video', 'text'\]/);
  assert.match(node, /关键帧优先/);
  assert.match(node, /videoFrameCount/);
  assert.match(node, /userVideos\.length === 0/);
  assert.match(node, /llmVideoMode/);
});

test('LLM node uses a higher default output token budget for long replies', () => {
  const canvas = read('src/components/Canvas.tsx');
  const node = read('src/components/nodes/LLMNode.tsx');
  const proxy = read('backend/src/routes/proxy.js');

  assert.match(canvas, /maxTokens:\s*16384/);
  assert.match(node, /d\?\.maxTokens === 'number' \? d\.maxTokens : 16384/);
  assert.match(node, /Number\(e\.target\.value\) \|\| 16384/);
  assert.match(proxy, /max_tokens:\s*max_tokens \?\? 16384/);
});

test('streaming LLM responses expose token-length truncation instead of silently ending', async () => {
  const originalFetch = globalThis.fetch;
  const encoder = new TextEncoder();
  try {
    globalThis.fetch = async () => new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"前半段"}}]}\n\n'));
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"后半段"},"finish_reason":"length"}]}\n\n'));
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        },
      }),
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
    ) as any;

    const chunks: string[] = [];
    const result = await generateLlmStream(
      { model: 'gemini-3.5-flash', messages: [{ role: 'user', content: '写长文' }], max_tokens: 4 },
      { onDelta: (chunk) => chunks.push(chunk) },
    );

    assert.equal(result.content, '前半段后半段');
    assert.deepEqual(chunks, ['前半段', '后半段']);
    assert.equal(result.finishReason, 'length');
    assert.equal(result.truncated, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('streaming LLM parser keeps final SSE data even without a trailing newline', async () => {
  const originalFetch = globalThis.fetch;
  const encoder = new TextEncoder();
  try {
    globalThis.fetch = async () => new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"前半段"}}]}\n\n'));
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"最后一段"},"finish_reason":"stop"}]}'));
          controller.close();
        },
      }),
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
    ) as any;

    const result = await generateLlmStream({
      model: 'gemini-3.5-flash',
      messages: [{ role: 'user', content: '写长文' }],
    });

    assert.equal(result.content, '前半段最后一段');
    assert.equal(result.finishReason, 'stop');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('LLM media normalizer converts local video references to absolute URLs in url mode', async () => {
  const messages = [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'describe this video' },
        { type: 'video_url', video_url: { url: '/files/output/demo.mp4' } },
      ],
    },
  ];

  const normalized = await normalizeLlmMessageMedia(messages, {
    llmVideoMode: 'url',
  }, {
    baseUrl: 'http://127.0.0.1:19999',
  });

  assert.equal(
    normalized[0].content[1].video_url.url,
    'http://127.0.0.1:19999/files/output/demo.mp4',
  );
  assert.equal(messages[0].content[1].video_url.url, '/files/output/demo.mp4');
});

test('bundled ffmpeg runtime is discoverable for LLM video compression', () => {
  const ffmpegPath = resolveBundledFfmpeg();
  assert.match(String(ffmpegPath).replace(/\\/g, '/'), /tools\/ffmpeg-runtime\/ffmpeg(\.exe)?$/);
  assert.equal(fs.existsSync(ffmpegPath), true);
});

test('LLM media normalizer preserves Base64 video mode as native video_url', async () => {
  const ffmpegPath = resolveBundledFfmpeg();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't8-llm-video-test-'));
  const videoPath = path.join(dir, 'sample.mp4');
  try {
    const made = spawnSync(ffmpegPath, [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=96x64:duration=1',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      videoPath,
    ], { encoding: 'utf8' });
    assert.equal(made.status, 0, made.stderr || made.stdout);
    assert.equal(fs.existsSync(videoPath), true);

    const normalized = await normalizeLlmMessageMedia([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'describe this video' },
          { type: 'video_url', video_url: { url: videoPath } },
        ],
      },
    ], {
      llmVideoMode: 'compressed-base64',
      videoMaxWidth: 256,
      videoMaxHeight: 256,
      videoMaxBase64Mb: 16,
    });

    const content = normalized[0].content;
    assert.equal(content.some((part: any) => part.type === 'image_url'), false);
    assert.equal(content.some((part: any) => part.type === 'text' && /关键帧/.test(part.text)), false);
    assert.equal(content.some((part: any) => part.type === 'video_url' && /^data:video\/mp4;base64,/.test(part.video_url.url)), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('LLM media normalizer extracts requested evenly-spread keyframes', async () => {
  const ffmpegPath = resolveBundledFfmpeg();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't8-llm-video-frames-test-'));
  const videoPath = path.join(dir, 'sample.mp4');
  try {
    const made = spawnSync(ffmpegPath, [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=96x64:duration=2',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      videoPath,
    ], { encoding: 'utf8' });
    assert.equal(made.status, 0, made.stderr || made.stdout);
    assert.equal(fs.existsSync(videoPath), true);

    const normalized = await normalizeLlmMessageMedia([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'describe this video' },
          { type: 'video_url', video_url: { url: videoPath } },
        ],
      },
    ], {
      llmVideoMode: 'frames',
      videoFrameCount: 4,
      videoMaxWidth: 256,
      videoMaxHeight: 256,
    });

    const content = normalized[0].content;
    const imageParts = content.filter((part: any) => part.type === 'image_url');
    assert.equal(content.some((part: any) => part.type === 'video_url'), false);
    assert.equal(content.some((part: any) => part.type === 'text' && /均匀抽取的 4 张关键帧/.test(part.text)), true);
    assert.equal(imageParts.length, 4);
    assert.equal(imageParts.every((part: any) => /^data:image\/jpeg;base64,/.test(part.image_url.url)), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
