import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import sharp from 'sharp';

const require = createRequire(import.meta.url);
const seedanceNz = require('../backend/src/providers/seedanceNz.js');

test('seedance.nz keeps TLS verification enabled with the pinned official root', () => {
  const source = readFileSync(new URL('../backend/src/providers/seedanceNz.js', import.meta.url), 'utf8');

  assert.match(source, /LETS_ENCRYPT_ROOT_YR/);
  assert.match(source, /rejectUnauthorized:\s*true/);
  assert.doesNotMatch(source, /rejectUnauthorized:\s*false/);
});

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const TINY_PNG_A = 'data:image/png;base64,iVBORw0KGgo=';
const TINY_PNG_B = 'data:image/png;base64,iVBORw0KGgox';
const TINY_MP3 = 'data:audio/mpeg;base64,SUQzAwAAAAA=';
const TINY_MP4 = 'data:video/mp4;base64,AAAAIGZ0eXBpc29tAAACAGlzb20=';

async function listen(handler: Parameters<typeof createServer>[0]) {
  const server = createServer(handler);
  server.on('connection', (socket) => socket.on('error', () => {}));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server;
}

async function closeServer(server: Awaited<ReturnType<typeof listen>>) {
  server.closeAllConnections?.();
  if (!server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

test('seedance.nz derives all 18 official model IDs from family and task type', () => {
  const families = [
    'standard', 'fast', 'mini',
    'global-standard', 'global-fast', 'global-mini',
  ];
  const taskTypes = ['t2v', 'i2v', 'multi'];
  const models = families.flatMap((family) => taskTypes.map((taskType) => (
    seedanceNz.resolveModel(family, taskType)
  )));

  assert.equal(new Set(models).size, 18);
  assert.ok(models.includes('seedance-2.0-standard-t2v'));
  assert.ok(models.includes('seedance-2.0-global-mini-multi'));
});

test('seedance.nz builds i2v payload with official images field and normalized native4k', async () => {
  seedanceNz.resetCachesForTests();
  let uploadIndex = 0;
  const fetchImpl = async (url: string) => {
    assert.match(url, /\/v1\/files\/upload$/);
    uploadIndex += 1;
    return jsonResponse({ url: `https://cdn.example.com/frame-${uploadIndex}.png` });
  };
  const built = await seedanceNz.buildPayload({
    model: 'standard',
    prompt: 'A calm camera move',
    duration: 5,
    ratio: '16:9',
    resolution: 'native4K',
    firstFrame: TINY_PNG_A,
    lastFrame: TINY_PNG_B,
  }, 'test-key', { fetchImpl, uploadIntervalMs: 0 });

  assert.equal(built.taskType, 'i2v');
  assert.equal(built.model, 'seedance-2.0-standard-i2v');
  assert.deepEqual(built.payload.images, [
    'https://cdn.example.com/frame-1.png',
    'https://cdn.example.com/frame-2.png',
  ]);
  assert.equal(built.payload.metadata.resolution, 'native4k');
  assert.equal(built.payload.seconds, '5');
  assert.equal('content' in built.payload.metadata, false);
});

test('seedance.nz uploads one image, one video and one audio then builds multi content', async () => {
  seedanceNz.resetCachesForTests();
  const uploads: Array<{ url: string; body: FormData }> = [];
  let uploadIndex = 0;
  const fetchImpl = async (url: string, init?: RequestInit) => {
    assert.match(url, /\/v1\/files\/upload$/);
    assert.ok(init?.body instanceof FormData);
    uploads.push({ url, body: init.body as FormData });
    uploadIndex += 1;
    return jsonResponse({ url: `https://cdn.example.com/ref-${uploadIndex}` });
  };

  const tinyPng = 'data:image/png;base64,iVBORw0KGgo=';
  const tinyMp4 = 'data:video/mp4;base64,AAAAHGZ0eXBpc29t';
  const tinyMp3 = 'data:audio/mpeg;base64,SUQzAwAAAAA=';
  const built = await seedanceNz.buildPayload({
    model: 'global-mini',
    prompt: 'Use @image_1, @VIDEO-1 and @audio1 together',
    duration: 4,
    ratio: 'adaptive',
    resolution: '480p',
    generate_audio: false,
    refImages: [tinyPng],
    videos: [tinyMp4],
    audios: [tinyMp3],
  }, 'test-key', { fetchImpl, uploadIntervalMs: 0 });

  assert.equal(uploads.length, 3);
  assert.equal(built.taskType, 'multi');
  assert.equal(built.model, 'seedance-2.0-global-mini-multi');
  assert.equal(built.payload.prompt, 'Use @Image 1, @Video 1 and @Audio 1 together');
  assert.deepEqual(built.payload.metadata.content, [
    { type: 'image_url', image_url: { url: 'https://cdn.example.com/ref-1' } },
    { type: 'video_url', video_url: { url: 'https://cdn.example.com/ref-2' } },
    { type: 'audio_url', audio_url: { url: 'https://cdn.example.com/ref-3' } },
  ]);
});

test('seedance.nz rejects mixed first-frame and multi-reference payloads', async () => {
  await assert.rejects(
    seedanceNz.buildPayload({
      model: 'mini',
      prompt: 'invalid mixed mode',
      firstFrame: 'https://assets.example.com/first.png',
      audios: ['https://assets.example.com/audio.mp3'],
    }, 'test-key'),
    /不能同时混入参考图、视频或音频/,
  );
});

test('seedance.nz submit and query use official endpoints and normalize completed output', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.endsWith('/v1/videos')) return jsonResponse({ id: 'task-123', status: 'queued' });
    return jsonResponse({ status: 'completed', progress: 100, metadata: { url: 'https://cdn.example.com/result.mp4' } });
  };

  const submitted = await seedanceNz.submitTask({
    model: 'mini',
    prompt: 'minimal test',
    duration: 4,
    ratio: '16:9',
    resolution: '480p',
  }, 'test-key', { baseUrl: 'https://api.seedance.nz', fetchImpl });
  const queried = await seedanceNz.queryTask('task-123', 'test-key', {
    baseUrl: 'https://api.seedance.nz',
    fetchImpl,
  });

  assert.equal(submitted.taskId, 'task-123');
  assert.equal(submitted.model, 'seedance-2.0-mini-t2v');
  assert.equal(calls[0].url, 'https://api.seedance.nz/v1/videos');
  assert.equal(calls[1].url, 'https://api.seedance.nz/v1/videos/task-123');
  assert.equal(queried.status, 'succeeded');
  assert.equal(queried.videoUrl, 'https://cdn.example.com/result.mp4');
});

test('seedance.nz builds official Seedream t2i and i2i payloads without mixing video fields', async () => {
  seedanceNz.resetCachesForTests();
  const t2i = await seedanceNz.buildImagePayload({
    prompt: 'a blue ceramic cup on a white table',
    resolution: '2k',
    output_format: 'png',
  }, 'test-key');

  assert.equal(t2i.model, 'seedream-v5-pro-t2i');
  assert.equal(t2i.taskType, 't2i');
  assert.deepEqual(t2i.payload, {
    model: 'seedream-v5-pro-t2i',
    prompt: 'a blue ceramic cup on a white table',
    metadata: { resolution: '2k', output_format: 'png' },
  });

  const fetchImpl = async (url: string, init?: RequestInit) => {
    assert.match(url, /\/v1\/files\/upload$/);
    assert.ok(init?.body instanceof FormData);
    return jsonResponse({ url: 'https://cdn.example.com/reference.png' });
  };
  const i2i = await seedanceNz.buildImagePayload({
    prompt: 'change the cup to glossy red',
    images: ['data:image/png;base64,iVBORw0KGgo='],
    size: '1280x960',
    output_format: 'jpeg',
  }, 'test-key', { fetchImpl, uploadIntervalMs: 0 });

  assert.equal(i2i.model, 'seedream-v5-pro-i2i');
  assert.equal(i2i.taskType, 'i2i');
  assert.deepEqual(i2i.payload, {
    model: 'seedream-v5-pro-i2i',
    prompt: 'change the cup to glossy red',
    images: ['https://cdn.example.com/reference.png'],
    metadata: { width: 1280, height: 960, output_format: 'jpeg' },
  });
  assert.equal('seconds' in i2i.payload, false);
});

test('seedance.nz APIMart image models follow the documented low-price and Grok payloads', async () => {
  seedanceNz.resetCachesForTests();
  let uploadIndex = 0;
  const fetchImpl = async (url: string) => {
    assert.match(url, /\/v1\/files\/upload$/);
    uploadIndex += 1;
    return jsonResponse({ url: `https://cdn.example.com/apimart-image-${uploadIndex}.png` });
  };

  const lowPrice = await seedanceNz.buildApimartImagePayload({
    model: 'zhenzhen-image-g-v2-lowprice',
    prompt: 'A product photograph',
    size: '16:9',
    resolution: '4k',
    n: 3,
    images: [TINY_PNG_A, TINY_PNG_B],
  }, 'test-key', { fetchImpl, uploadIntervalMs: 0 });
  assert.deepEqual(lowPrice, {
    model: 'zhenzhen-image-g-v2-lowprice',
    taskType: 'i2i',
    payload: {
      model: 'zhenzhen-image-g-v2-lowprice',
      prompt: 'A product photograph',
      n: 3,
      size: '16:9',
      metadata: { resolution: '4k' },
      images: [
        'https://cdn.example.com/apimart-image-1.png',
        'https://cdn.example.com/apimart-image-2.png',
      ],
    },
  });

  const grokText = await seedanceNz.buildApimartImagePayload({
    model: 'zhenzhen-image-gk-v15',
    prompt: 'A cinematic skyline',
    size: '3:2',
    n: 2,
  }, 'test-key');
  assert.deepEqual(grokText.payload, {
    model: 'zhenzhen-image-gk-v15',
    prompt: 'A cinematic skyline',
    n: 2,
    size: '3:2',
  });

  const grokEdit = await seedanceNz.buildApimartImagePayload({
    model: 'zhenzhen-image-gk-v15-edit',
    prompt: 'Replace the sky',
    size: '16:9',
    images: [TINY_PNG_A, TINY_PNG_B],
  }, 'test-key', { fetchImpl, uploadIntervalMs: 0 });
  assert.equal(grokEdit.taskType, 'i2i');
  assert.deepEqual(grokEdit.payload.images, ['https://cdn.example.com/apimart-image-1.png']);

  await assert.rejects(
    seedanceNz.buildApimartImagePayload({
      model: 'zhenzhen-image-gk-v15',
      prompt: 'Must stay text-to-image',
      images: [TINY_PNG_A],
    }, 'test-key', { fetchImpl, uploadIntervalMs: 0 }),
    /文生图模型，不接受参考图/,
  );
});

test('seedance.nz APIMart video models preserve each documented duration and reference constraint', async () => {
  seedanceNz.resetCachesForTests();
  let uploadIndex = 0;
  const fetchImpl = async (url: string) => {
    assert.match(url, /\/v1\/files\/upload$/);
    uploadIndex += 1;
    return jsonResponse({ url: `https://cdn.example.com/apimart-video-ref-${uploadIndex}` });
  };

  const omni = await seedanceNz.buildApimartVideoPayload({
    model: 'zhenzhen-video-g-omni-flash',
    prompt: '',
    ratio: '9:16',
    images: [TINY_PNG_A],
    videos: [TINY_MP4],
  }, 'test-key', { fetchImpl, uploadIntervalMs: 0 });
  assert.equal(omni.payload.model, 'zhenzhen-video-g-omni-flash');
  assert.deepEqual(omni.payload.metadata, {
    resolution: '720p',
    ratio: '9:16',
    video_url: 'https://cdn.example.com/apimart-video-ref-2',
  });
  assert.deepEqual(omni.payload.images, ['https://cdn.example.com/apimart-video-ref-1']);
  assert.equal('seconds' in omni.payload, false);

  const grok = await seedanceNz.buildApimartVideoPayload({
    model: 'zhenzhen-video-gk-v15',
    prompt: 'A slow dolly shot',
    duration: 30,
    ratio: '2:3',
    resolution: '480p',
    images: [TINY_PNG_A],
  }, 'test-key', { fetchImpl, uploadIntervalMs: 0 });
  assert.equal(grok.payload.seconds, '30');
  assert.deepEqual(grok.payload.metadata, { resolution: '480p', ratio: '2:3' });

  const veoFast = await seedanceNz.buildApimartVideoPayload({
    model: 'zhenzhen-video-v31-fast',
    prompt: 'Fast camera move',
    duration: 15,
    ratio: '16:9',
    resolution: '4K',
  }, 'test-key');
  assert.equal(veoFast.payload.seconds, '8');
  assert.deepEqual(veoFast.payload.metadata, { resolution: '4k', ratio: '16:9' });

  await assert.rejects(
    seedanceNz.buildApimartVideoPayload({
      model: 'zhenzhen-video-v31-quality',
      prompt: 'Quality render',
      images: [TINY_PNG_A, TINY_PNG_A, TINY_PNG_A],
    }, 'test-key', { fetchImpl, uploadIntervalMs: 0 }),
    /最多支持 2 张参考图/,
  );
});

test('seedance.nz Whisper uses the documented synchronous multipart transcription endpoint', async () => {
  let calledUrl = '';
  let submittedForm: FormData | null = null;
  const result = await seedanceNz.transcribeAudio({
    audioUrl: TINY_MP3,
    model: 'whisper-1',
    responseFormat: 'verbose_json',
  }, 'test-key', {
    baseUrl: 'https://api.seedance.nz',
    fetchImpl: async (url: string, init?: RequestInit) => {
      calledUrl = url;
      assert.equal(init?.method, 'POST');
      assert.equal((init?.headers as Record<string, string>)?.Authorization, 'Bearer test-key');
      assert.ok(init?.body instanceof FormData);
      submittedForm = init.body as FormData;
      return jsonResponse({ text: 'documented transcript' });
    },
  });

  assert.equal(calledUrl, 'https://api.seedance.nz/v1/audio/transcriptions');
  assert.equal(submittedForm?.get('model'), 'whisper-1');
  assert.equal(submittedForm?.get('response_format'), 'verbose_json');
  assert.equal((submittedForm?.get('file') as File)?.name, 'seedance-audio.mp3');
  assert.equal(result.text, 'documented transcript');

  await assert.rejects(
    seedanceNz.transcribeAudio({
      audioUrl: 'data:audio/webm;base64,GkXfo0AgQoaBAULygQFC8oEE',
      model: 'whisper-1',
    }, 'test-key', { fetchImpl: async () => jsonResponse({ text: 'must not submit' }) }),
    /不支持该文件格式/,
  );
});

test('seedance.nz builds documented Zhenzhen Image G-2 t2i and i2i payloads', async () => {
  seedanceNz.resetCachesForTests();
  const t2i = await seedanceNz.buildImagePayload({
    model: 'zhenzhen-image-g2-t2i',
    prompt: 'clean product photo on a white background',
    images: ['https://assets.example.com/ignored.png'],
    resolution: '1k',
    ratio: 'adaptive',
  }, 'test-key');
  assert.deepEqual(t2i, {
    model: 'zhenzhen-image-g2-t2i',
    taskType: 't2i',
    payload: {
      model: 'zhenzhen-image-g2-t2i',
      prompt: 'clean product photo on a white background',
      metadata: { resolution: '1k' },
    },
  });

  const uploads: string[] = [];
  const i2i = await seedanceNz.buildImagePayload({
    model: 'zhenzhen-image-g2-i2i',
    prompt: 'turn this into a glossy blue app icon',
    images: [TINY_PNG_A, TINY_PNG_B],
    resolution: '1k',
    ratio: '1:1',
  }, 'test-key', {
    uploadIntervalMs: 0,
    fetchImpl: async (url: string) => {
      assert.match(url, /\/v1\/files\/upload$/);
      uploads.push(url);
      return jsonResponse({ url: `https://cdn.example.com/g2-ref-${uploads.length}.png` });
    },
  });
  assert.deepEqual(i2i.payload, {
    model: 'zhenzhen-image-g2-i2i',
    prompt: 'turn this into a glossy blue app icon',
    images: [
      'https://cdn.example.com/g2-ref-1.png',
      'https://cdn.example.com/g2-ref-2.png',
    ],
    metadata: { resolution: '1k', ratio: '1:1' },
  });
  assert.equal(i2i.taskType, 'i2i');
  assert.equal(uploads.length, 2);
});

test('seedance.nz rejects undocumented Zhenzhen Image G-2 combinations before upstream submission', async () => {
  await assert.rejects(
    seedanceNz.buildImagePayload({
      model: 'zhenzhen-image-g2-i2i', prompt: 'valid prompt', resolution: '1k', images: [],
    }, 'test-key'),
    /至少需要 1 张参考图/,
  );
  await assert.rejects(
    seedanceNz.buildImagePayload({
      model: 'zhenzhen-image-g2-t2i', prompt: 'x'.repeat(20001), resolution: '1k',
    }, 'test-key'),
    /不能超过 20000 字符/,
  );
  await assert.rejects(
    seedanceNz.buildImagePayload({
      model: 'zhenzhen-image-g2-t2i', prompt: 'valid prompt', resolution: '2k',
    }, 'test-key'),
    /分辨率只能是 1k/,
  );
  await assert.rejects(
    seedanceNz.buildImagePayload({
      model: 'zhenzhen-image-g2-t2i', prompt: 'valid prompt', resolution: '1k', ratio: 'bad-ratio',
    }, 'test-key'),
    /不支持比例/,
  );
  await assert.rejects(
    seedanceNz.buildImagePayload({
      model: 'zhenzhen-image-g2-t2i', prompt: 'valid prompt', resolution: '1k', output_format: 'png',
    }, 'test-key'),
    /不支持 output_format/,
  );
});

test('seedance.nz selects the documented Dola Seedream overseas t2i and i2i models', async () => {
  seedanceNz.resetCachesForTests();
  const t2i = await seedanceNz.buildImagePayload({
    modelFamily: 'overseas',
    prompt: 'a cinematic lighthouse above a stormy sea',
    resolution: '1k',
    output_format: 'png',
  }, 'test-key');
  assert.equal(t2i.model, 'dola-seedream-5.0-pro-t2i');
  assert.equal(t2i.payload.model, 'dola-seedream-5.0-pro-t2i');

  const i2i = await seedanceNz.buildImagePayload({
    model: 'dola-seedream-5.0-pro-t2i',
    prompt: 'change the weather to a warm sunset',
    images: [TINY_PNG_A],
    resolution: '2k',
    output_format: 'jpeg',
  }, 'test-key', {
    uploadIntervalMs: 0,
    fetchImpl: async () => jsonResponse({ url: 'https://cdn.example.com/lighthouse.png' }),
  });
  assert.equal(i2i.model, 'dola-seedream-5.0-pro-i2i');
  assert.equal(i2i.payload.model, 'dola-seedream-5.0-pro-i2i');
  assert.deepEqual(i2i.payload.images, ['https://cdn.example.com/lighthouse.png']);
});

test('seedance.nz Seedream submit and query use the documented image endpoints', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.endsWith('/v1/image/generations')) {
      return jsonResponse({ id: 'image-task-123', task_id: 'image-task-123', status: 'queued' });
    }
    return jsonResponse({
      code: 'success',
      data: {
        task_id: 'image-task-123',
        status: 'SUCCESS',
        progress: '100%',
        result_url: 'https://cdn.example.com/result.png',
      },
    });
  };

  const submitted = await seedanceNz.submitImageTask({
    prompt: 'a minimal product photograph',
    resolution: '1k',
  }, 'test-key', { baseUrl: 'https://api.seedance.nz', fetchImpl });
  const queried = await seedanceNz.queryImageTask(submitted.taskId, 'test-key', {
    baseUrl: 'https://api.seedance.nz',
    fetchImpl,
  });

  assert.equal(calls[0].url, 'https://api.seedance.nz/v1/image/generations');
  assert.equal(calls[1].url, 'https://api.seedance.nz/v1/image/generations/image-task-123');
  assert.equal(submitted.model, 'seedream-v5-pro-t2i');
  assert.equal(queried.status, 'succeeded');
  assert.equal(queried.imageUrl, 'https://cdn.example.com/result.png');
});

test('seedance.nz builds all three Happy Horse payload modes without mixing Seedance fields', async () => {
  seedanceNz.resetCachesForTests();
  let uploadIndex = 0;
  const options = {
    uploadIntervalMs: 0,
    fetchImpl: async () => {
      uploadIndex += 1;
      return jsonResponse({ url: `https://cdn.example.com/happy-ref-${uploadIndex}.png` });
    },
  };
  const t2v = await seedanceNz.buildHappyHorsePayload({
    model: 'happyhorse-1.1-t2v',
    prompt: 'A paper horse runs through a miniature city',
    duration: 3,
    resolution: '720p',
    ratio: '16:9',
    images: ['https://assets.example.com/ignored.png'],
  }, 'test-key', options);
  assert.deepEqual(t2v.payload, {
    model: 'happyhorse-1.1-t2v',
    prompt: 'A paper horse runs through a miniature city',
    seconds: '3',
    metadata: { resolution: '720p', ratio: '16:9' },
  });

  const i2v = await seedanceNz.buildHappyHorsePayload({
    model: 'happyhorse-1.1-i2v',
    duration: 4,
    resolution: '1080p',
    ratio: 'adaptive',
    images: [TINY_PNG_A, TINY_PNG_B],
  }, 'test-key', options);
  assert.equal(i2v.taskType, 'i2v');
  assert.deepEqual(i2v.payload.images, ['https://cdn.example.com/happy-ref-1.png']);

  const r2v = await seedanceNz.buildHappyHorsePayload({
    model: 'happyhorse-1.1-r2v',
    prompt: '图1 的角色采用图2 的服装',
    duration: 15,
    resolution: '720p',
    ratio: '9:16',
    images: [TINY_PNG_A, TINY_PNG_B],
  }, 'test-key', options);
  assert.equal(r2v.taskType, 'r2v');
  assert.equal(r2v.payload.images.length, 2);
  assert.equal(r2v.payload.seconds, '15');
});

test('seedance.nz Happy Horse submit uses /v1/videos and rejects invalid limits', async () => {
  const calls: string[] = [];
  const fetchImpl = async (url: string) => {
    calls.push(url);
    return jsonResponse({ id: 'happy-task-1', status: 'queued' });
  };
  const result = await seedanceNz.submitHappyHorseTask({
    model: 'happyhorse-1.1-t2v',
    prompt: 'A minimal live test animation',
    duration: 3,
    resolution: '720p',
    ratio: '16:9',
  }, 'test-key', { baseUrl: 'https://api.seedance.nz', fetchImpl });
  assert.equal(result.taskId, 'happy-task-1');
  assert.equal(calls[0], 'https://api.seedance.nz/v1/videos');
  await assert.rejects(
    seedanceNz.buildHappyHorsePayload({
      model: 'happyhorse-1.1-r2v', duration: 2, resolution: '4k', images: [],
    }, 'test-key'),
    /分辨率只支持 720p 或 1080p|时长只支持 3-15 秒|至少需要 1 张参考图/,
  );
});

test('seedance.nz builds documented Kling t2v, i2v and r2v payloads', async () => {
  seedanceNz.resetCachesForTests();
  const t2v = await seedanceNz.buildKlingPayload({
    model: 'kling-v3.0-std-t2v',
    prompt: 'A compact product reveal shot',
    duration: 5,
    ratio: '16:9',
    negativePrompt: '',
    images: [TINY_PNG_A],
  }, 'test-key');
  assert.deepEqual(t2v, {
    model: 'kling-v3.0-std-t2v',
    taskType: 't2v',
    payload: {
      model: 'kling-v3.0-std-t2v',
      prompt: 'A compact product reveal shot',
      seconds: '5',
      metadata: { ratio: '16:9' },
    },
  });

  let uploadIndex = 0;
  const upload = async (url: string) => {
    assert.match(url, /\/v1\/files\/upload$/);
    uploadIndex += 1;
    return jsonResponse({ url: `https://cdn.example.com/kling-${uploadIndex}.png` });
  };
  const i2v = await seedanceNz.buildKlingPayload({
    model: 'kling-v3.0-pro-i2v',
    prompt: 'Move from the first frame to the second',
    duration: 10,
    ratio: 'adaptive',
    negativePrompt: 'blur',
    images: [TINY_PNG_A, TINY_PNG_B, TINY_PNG_A],
  }, 'test-key', { fetchImpl: upload, uploadIntervalMs: 0 });
  assert.deepEqual(i2v.payload, {
    model: 'kling-v3.0-pro-i2v',
    prompt: 'Move from the first frame to the second',
    seconds: '10',
    metadata: { negative_prompt: 'blur' },
    images: ['https://cdn.example.com/kling-1.png', 'https://cdn.example.com/kling-2.png'],
  });

  seedanceNz.resetCachesForTests();
  uploadIndex = 0;
  const r2v = await seedanceNz.buildKlingPayload({
    model: 'kling-o3-4k-r2v',
    prompt: 'Use image1 as the product and image2 as the environment',
    duration: 5,
    ratio: '9:16',
    images: [TINY_PNG_A, TINY_PNG_B, TINY_PNG_A, TINY_PNG_B, TINY_PNG_A],
  }, 'test-key', { fetchImpl: upload, uploadIntervalMs: 0 });
  assert.equal(r2v.taskType, 'r2v');
  assert.equal(r2v.payload.images.length, 4);
  assert.deepEqual(r2v.payload.metadata, { ratio: '9:16' });
});

test('seedance.nz builds documented Kling edit payload and validates mode limits', async () => {
  seedanceNz.resetCachesForTests();
  const built = await seedanceNz.buildKlingPayload({
    model: 'kling-o3-std-edit',
    prompt: 'Turn the product red',
    duration: 5,
    videos: [TINY_MP4],
  }, 'test-key', {
    uploadIntervalMs: 0,
    fetchImpl: async (url: string) => {
      assert.match(url, /\/v1\/files\/upload$/);
      return jsonResponse({ url: 'https://cdn.example.com/kling-source.mp4' });
    },
  });
  assert.deepEqual(built, {
    model: 'kling-o3-std-edit',
    taskType: 'edit',
    payload: {
      model: 'kling-o3-std-edit',
      prompt: 'Turn the product red',
      seconds: '5',
      metadata: {
        content: [{
          type: 'video_url',
          video_url: { url: 'https://cdn.example.com/kling-source.mp4' },
        }],
      },
    },
  });

  await assert.rejects(
    seedanceNz.buildKlingPayload({
      model: 'kling-v3.0-std-t2v', prompt: 'valid', duration: 6, ratio: '16:9',
    }, 'test-key'),
    /时长只支持 5 或 10 秒/,
  );
  await assert.rejects(
    seedanceNz.buildKlingPayload({
      model: 'kling-o3-std-r2v', prompt: 'valid', duration: 5, ratio: '16:9', images: [],
    }, 'test-key'),
    /至少需要 1 张参考图/,
  );
  await assert.rejects(
    seedanceNz.buildKlingPayload({
      model: 'kling-o3-pro-edit', prompt: '', duration: 5, videos: [TINY_MP4],
    }, 'test-key'),
    /视频编辑必须填写提示词/,
  );
});

test('seedance.nz submits Kling through /v1/videos', async () => {
  const calls: string[] = [];
  const submitted = await seedanceNz.submitKlingTask({
    model: 'kling-v3-turbo-std-t2v',
    prompt: 'A minimal Kling submission test',
    duration: 5,
    ratio: '16:9',
  }, 'test-key', {
    baseUrl: 'https://api.seedance.nz',
    fetchImpl: async (url: string) => {
      calls.push(url);
      return jsonResponse({ id: 'kling-task-1', status: 'queued' });
    },
  });
  assert.equal(submitted.taskId, 'kling-task-1');
  assert.equal(submitted.taskType, 't2v');
  assert.deepEqual(calls, ['https://api.seedance.nz/v1/videos']);
});

test('seedance.nz builds the documented Zhenzhen Upscaler payload from exactly one MP4', async () => {
  seedanceNz.resetCachesForTests();
  const built = await seedanceNz.buildUpscalerPayload({
    model: 'zhenzhen-upscaler',
    resolution: '2k',
    videos: [TINY_MP4],
    prompt: 'must not be forwarded',
    duration: 15,
  }, 'test-key', {
    uploadIntervalMs: 0,
    fetchImpl: async (url: string) => {
      assert.match(url, /\/v1\/files\/upload$/);
      return jsonResponse({ url: 'https://cdn.example.com/upscaler-source.mp4' });
    },
  });
  assert.deepEqual(built, {
    model: 'zhenzhen-upscaler',
    taskType: 'upscale',
    payload: {
      model: 'zhenzhen-upscaler',
      prompt: 'upscale',
      metadata: {
        resolution: '2k',
        content: [{
          type: 'video_url',
          video_url: { url: 'https://cdn.example.com/upscaler-source.mp4' },
        }],
      },
    },
  });

  await assert.rejects(
    seedanceNz.buildUpscalerPayload({ model: 'zhenzhen-upscaler', resolution: '8k', videos: [TINY_MP4] }, 'test-key'),
    /分辨率只支持 720p、1080p、2k 或 4k/,
  );
  await assert.rejects(
    seedanceNz.buildUpscalerPayload({ model: 'zhenzhen-upscaler', resolution: '1080p', videos: [] }, 'test-key'),
    /必须提供且只能提供 1 个 MP4/,
  );
  await assert.rejects(
    seedanceNz.buildUpscalerPayload({ model: 'zhenzhen-upscaler', resolution: '1080p', videos: [TINY_MP4, TINY_MP4] }, 'test-key'),
    /必须提供且只能提供 1 个 MP4/,
  );
});

test('seedance.nz submits Zhenzhen Upscaler through /v1/videos without seconds', async () => {
  seedanceNz.resetCachesForTests();
  const calls: Array<{ url: string; body: any }> = [];
  const submitted = await seedanceNz.submitUpscalerTask({
    model: 'zhenzhen-upscaler',
    resolution: '720p',
    videos: [TINY_MP4],
  }, 'test-key', {
    baseUrl: 'https://api.seedance.nz',
    uploadIntervalMs: 0,
    fetchImpl: async (url: string, init: any = {}) => {
      if (url.endsWith('/v1/files/upload')) return jsonResponse({ url: 'https://cdn.example.com/source.mp4' });
      calls.push({ url, body: JSON.parse(init.body) });
      return jsonResponse({ id: 'upscaler-task-1', status: 'queued' });
    },
  });
  assert.equal(submitted.taskId, 'upscaler-task-1');
  assert.equal(submitted.taskType, 'upscale');
  assert.equal(calls[0].url, 'https://api.seedance.nz/v1/videos');
  assert.equal(Object.hasOwn(calls[0].body, 'seconds'), false);
});

test('seedance.nz builds the documented Hailuo 2.3 t2v and i2v payloads', async () => {
  seedanceNz.resetCachesForTests();
  const t2v = await seedanceNz.buildHailuoPayload({
    model: 'hailuo-2.3-t2v-standard',
    prompt: 'A compact product reveal shot',
    duration: 6,
    resolution: '768p',
    ratio: '16:9',
    images: [TINY_PNG_A],
  }, 'test-key');
  assert.deepEqual(t2v, {
    model: 'hailuo-2.3-t2v-standard',
    taskType: 't2v',
    payload: {
      model: 'hailuo-2.3-t2v-standard',
      prompt: 'A compact product reveal shot',
      seconds: '6',
      metadata: { resolution: '768p', ratio: '16:9' },
    },
  });

  const validFirstFrame = `data:image/png;base64,${(
    await sharp({ create: { width: 512, height: 512, channels: 3, background: '#65a30d' } }).png().toBuffer()
  ).toString('base64')}`;
  const i2v = await seedanceNz.buildHailuoPayload({
    model: 'hailuo-2.3-fast-pro-i2v',
    prompt: 'Gentle product motion',
    duration: 10,
    resolution: '768p',
    ratio: '9:16',
    images: [validFirstFrame, TINY_PNG_B],
  }, 'test-key', {
    uploadIntervalMs: 0,
    fetchImpl: async (url: string) => {
      assert.match(url, /\/v1\/files\/upload$/);
      return jsonResponse({ url: 'https://cdn.example.com/hailuo-first.png' });
    },
  });
  assert.deepEqual(i2v, {
    model: 'hailuo-2.3-fast-pro-i2v',
    taskType: 'i2v',
    payload: {
      model: 'hailuo-2.3-fast-pro-i2v',
      prompt: 'Gentle product motion',
      seconds: '10',
      metadata: { resolution: '768p' },
      images: ['https://cdn.example.com/hailuo-first.png'],
    },
  });
});

test('seedance.nz Hailuo 2.3 validates model limits and submits through /v1/videos', async () => {
  const validFirstFrame = `data:image/png;base64,${(
    await sharp({ create: { width: 512, height: 512, channels: 3, background: '#0891b2' } }).png().toBuffer()
  ).toString('base64')}`;
  const tooSmallFrame = `data:image/png;base64,${(
    await sharp({ create: { width: 512, height: 300, channels: 3, background: '#dc2626' } }).png().toBuffer()
  ).toString('base64')}`;

  await assert.rejects(
    seedanceNz.buildHailuoPayload({
      model: 'hailuo-2.3-t2v-standard', prompt: 'Valid prompt', duration: 10, resolution: '1080p', ratio: '16:9',
    }, 'test-key'),
    /1080p 只支持 6 秒/,
  );
  await assert.rejects(
    seedanceNz.buildHailuoPayload({
      model: 'hailuo-2.3-i2v-standard', duration: 6, resolution: '768p', images: [tooSmallFrame],
    }, 'test-key', { uploadIntervalMs: 0, fetchImpl: async () => jsonResponse({ url: 'must-not-upload' }) }),
    /短边必须大于 300px/,
  );
  await assert.rejects(
    seedanceNz.buildHailuoPayload({
      model: 'hailuo-2.3-t2v-pro', prompt: 'x'.repeat(2001), duration: 6, resolution: '768p', ratio: '16:9',
    }, 'test-key'),
    /不能超过 2000 字符/,
  );

  seedanceNz.resetCachesForTests();
  const calls: string[] = [];
  const submitted = await seedanceNz.submitHailuoTask({
    model: 'hailuo-2.3-i2v-pro',
    duration: 6,
    resolution: '1080p',
    images: [validFirstFrame],
  }, 'test-key', {
    baseUrl: 'https://api.seedance.nz',
    uploadIntervalMs: 0,
    fetchImpl: async (url: string) => {
      calls.push(url);
      return url.endsWith('/v1/files/upload')
        ? jsonResponse({ url: 'https://cdn.example.com/hailuo-submit-first.png' })
        : jsonResponse({ id: 'hailuo-task-1', status: 'queued' });
    },
  });
  assert.equal(submitted.taskId, 'hailuo-task-1');
  assert.deepEqual(calls, [
    'https://api.seedance.nz/v1/files/upload',
    'https://api.seedance.nz/v1/videos',
  ]);
});

test('seedance.nz builds documented Vidu Q3 t2v, i2v, start-end and r2v payloads', async () => {
  seedanceNz.resetCachesForTests();
  const t2v = await seedanceNz.buildViduPayload({
    model: 'vidu-q3-turbo-t2v',
    prompt: 'A paper bird takes flight in a clean studio',
    duration: 4,
    ratio: '16:9',
    resolution: 'default',
    seed: -1,
    images: [TINY_PNG_A],
  }, 'test-key');
  assert.deepEqual(t2v, {
    model: 'vidu-q3-turbo-t2v',
    taskType: 't2v',
    payload: {
      model: 'vidu-q3-turbo-t2v',
      prompt: 'A paper bird takes flight in a clean studio',
      seconds: '4',
      metadata: { ratio: '16:9' },
    },
  });

  let uploadIndex = 0;
  const upload = async (url: string) => {
    assert.match(url, /\/v1\/files\/upload$/);
    uploadIndex += 1;
    return jsonResponse({ url: `https://cdn.example.com/vidu-${uploadIndex}.png` });
  };
  const i2v = await seedanceNz.buildViduPayload({
    model: 'vidu-q3-pro-i2v',
    duration: 5,
    ratio: 'adaptive',
    resolution: '720p',
    seed: 7,
    images: [TINY_PNG_A, TINY_PNG_B],
  }, 'test-key', { fetchImpl: upload, uploadIntervalMs: 0 });
  assert.deepEqual(i2v.payload, {
    model: 'vidu-q3-pro-i2v',
    seconds: '5',
    metadata: { resolution: '720p', seed: 7 },
    images: ['https://cdn.example.com/vidu-1.png'],
  });

  seedanceNz.resetCachesForTests();
  uploadIndex = 0;
  const startEnd = await seedanceNz.buildViduPayload({
    model: 'vidu-q3-pro-fast-start-end',
    prompt: 'Move smoothly from the first composition to the second',
    duration: 6,
    ratio: '9:16',
    resolution: '1080p',
    images: [TINY_PNG_A, TINY_PNG_B],
  }, 'test-key', { fetchImpl: upload, uploadIntervalMs: 0 });
  assert.equal(startEnd.taskType, 'start-end');
  assert.deepEqual(startEnd.payload.images, [
    'https://cdn.example.com/vidu-1.png',
    'https://cdn.example.com/vidu-2.png',
  ]);
  assert.deepEqual(startEnd.payload.metadata, { ratio: '9:16', resolution: '1080p' });

  seedanceNz.resetCachesForTests();
  uploadIndex = 0;
  const r2v = await seedanceNz.buildViduPayload({
    model: 'vidu-q3-drama-r2v',
    duration: 4,
    ratio: 'adaptive',
    resolution: 'default',
    images: Array.from({ length: 10 }, (_, index) => index % 2 ? TINY_PNG_A : TINY_PNG_B),
  }, 'test-key', { fetchImpl: upload, uploadIntervalMs: 0 });
  assert.equal(r2v.taskType, 'r2v');
  assert.equal(r2v.payload.images.length, 9);
  assert.deepEqual(r2v.payload.metadata, {});
});

test('seedance.nz builds the documented Vidu Q3 short-play payload', async () => {
  seedanceNz.resetCachesForTests();
  const built = await seedanceNz.buildViduPayload({
    model: 'vidu-q3-drama-short-play',
    prompt: 'Scene one: a designer presents a small ceramic bird in a quiet studio.',
    scriptName: 'Studio intro',
    duration: 8,
    ratio: '9:16',
    resolution: '1080p',
    style: 'realistic',
    assetType: 'character',
    assetNamePrefix: 'Hero',
    assetDescription: 'Designer in a clean studio',
    images: [TINY_PNG_A],
  }, 'test-key', {
    uploadIntervalMs: 0,
    fetchImpl: async () => jsonResponse({ url: 'https://cdn.example.com/vidu-asset.png' }),
  });
  assert.deepEqual(built, {
    model: 'vidu-q3-drama-short-play',
    taskType: 'short-play',
    payload: {
      model: 'vidu-q3-drama-short-play',
      prompt: 'Scene one: a designer presents a small ceramic bird in a quiet studio.',
      metadata: {
        script_name: 'Studio intro',
        resolution: '1080p',
        duration: 8,
        aspect_ratio: '9:16',
        style: 'realistic',
        assets: [{
          id: '1',
          type: 'character',
          name: 'Hero 1',
          image_uri: 'https://cdn.example.com/vidu-asset.png',
          description: 'Designer in a clean studio',
        }],
      },
    },
  });
});

test('seedance.nz Vidu Q3 validates mode limits and submits through /v1/videos', async () => {
  await assert.rejects(
    seedanceNz.buildViduPayload({
      model: 'vidu-q3-pro-t2v', prompt: 'valid', duration: 3, ratio: '16:9', resolution: '720p',
    }, 'test-key'),
    /时长只支持 4-15 秒/,
  );
  await assert.rejects(
    seedanceNz.buildViduPayload({
      model: 'vidu-q3-turbo-start-end', duration: 4, ratio: '16:9', resolution: 'default', images: [TINY_PNG_A],
    }, 'test-key'),
    /必须提供第 1 张和第 2 张图片/,
  );
  await assert.rejects(
    seedanceNz.buildViduPayload({
      model: 'vidu-q3-ad-short-play', prompt: 'valid script', scriptName: '', duration: 8, ratio: '9:16', resolution: '1080p', images: [TINY_PNG_A],
    }, 'test-key'),
    /必须填写脚本名称/,
  );

  const calls: string[] = [];
  const submitted = await seedanceNz.submitViduTask({
    model: 'vidu-q3-pro-fast-t2v',
    prompt: 'A minimal Vidu submission test',
    duration: 4,
    ratio: '16:9',
    resolution: 'default',
  }, 'test-key', {
    baseUrl: 'https://api.seedance.nz',
    fetchImpl: async (url: string) => {
      calls.push(url);
      return jsonResponse({ id: 'vidu-task-1', status: 'queued' });
    },
  });
  assert.equal(submitted.taskId, 'vidu-task-1');
  assert.deepEqual(calls, ['https://api.seedance.nz/v1/videos']);
});

test('seedance.nz builds and submits the documented Wan 2.7 Spicy i2v payload', async () => {
  seedanceNz.resetCachesForTests();
  let buildUploadIndex = 0;
  const built = await seedanceNz.buildWanPayload({
    model: 'wan-2.7-spicy-i2v',
    prompt: 'the character turns toward the camera',
    duration: 2,
    resolution: '1080p',
    images: [TINY_PNG_A, TINY_PNG_B],
    negativePrompt: 'blurry, distorted hands',
    audioUrl: TINY_MP3,
    promptExtend: true,
    seed: 42,
  }, 'test-key', {
    uploadIntervalMs: 0,
    fetchImpl: async () => {
      buildUploadIndex += 1;
      return jsonResponse({
        url: buildUploadIndex === 1
          ? 'https://cdn.example.com/music.mp3'
          : 'https://cdn.example.com/first.png',
      });
    },
  });
  assert.deepEqual(built.payload, {
    model: 'wan-2.7-spicy-i2v',
    prompt: 'the character turns toward the camera',
    seconds: '2',
    images: ['https://cdn.example.com/first.png'],
    metadata: {
      resolution: '1080p',
      negative_prompt: 'blurry, distorted hands',
      audio_url: 'https://cdn.example.com/music.mp3',
      prompt_extend: true,
      seed: 42,
    },
  });

  seedanceNz.resetCachesForTests();
  const calls: string[] = [];
  const fetchImpl = async (url: string) => {
    calls.push(url);
    if (url.endsWith('/v1/files/upload')) {
      return jsonResponse({ url: 'https://cdn.example.com/submitted-first.png' });
    }
    return jsonResponse({ id: 'wan-task-1', status: 'queued' });
  };
  const submitted = await seedanceNz.submitWanTask({
    model: 'wan-2.7-spicy-i2v',
    duration: 15,
    resolution: '720p',
    images: [TINY_PNG_A],
  }, 'test-key', { baseUrl: 'https://api.seedance.nz', fetchImpl, uploadIntervalMs: 0 });
  assert.equal(submitted.taskId, 'wan-task-1');
  assert.deepEqual(calls, [
    'https://api.seedance.nz/v1/files/upload',
    'https://api.seedance.nz/v1/videos',
  ]);

  await assert.rejects(
    seedanceNz.buildWanPayload({
      model: 'wan-2.7-spicy-i2v', duration: 1, resolution: '4k', images: [],
    }, 'test-key'),
    /必须提供 1 张首帧图|时长只支持 2-15 秒|分辨率只支持 720p 或 1080p/,
  );
});

test('seedance.nz builds Seed Audio payload and enforces mutually exclusive references', async () => {
  const built = await seedanceNz.buildAudioPayload({
    model: 'doubao-seed-audio-1.0',
    prompt: 'gentle rain falling on a quiet city street at night',
    speaker: 'zh_male_shaonianzixin_uranus_bigtts',
    outputFormat: 'mp3',
    sampleRate: '24000',
    speechRate: 10,
    loudnessRate: -5,
    pitchRate: 2,
  }, 'test-key');
  assert.deepEqual(built.payload, {
    model: 'doubao-seed-audio-1.0',
    prompt: 'gentle rain falling on a quiet city street at night',
    metadata: {
      format: 'mp3', sample_rate: '24000', speech_rate: 10, loudness_rate: -5, pitch_rate: 2,
      speaker: 'zh_male_shaonianzixin_uranus_bigtts',
    },
  });
  await assert.rejects(
    seedanceNz.buildAudioPayload({
      prompt: 'valid audio prompt',
      speaker: 'voice-id',
      images: ['https://assets.example.com/ref.png'],
    }, 'test-key'),
    /只能选择一种/,
  );
});

test('seedance.nz Seed Audio submit and query use documented async audio endpoints', async () => {
  const calls: string[] = [];
  const fetchImpl = async (url: string) => {
    calls.push(url);
    if (url.endsWith('/v1/audio/generations')) {
      return jsonResponse({ id: 'audio-task-1', task_id: 'audio-task-1', status: 'queued' });
    }
    return jsonResponse({
      code: 'success',
      data: {
        task_id: 'audio-task-1', status: 'SUCCESS', progress: '100%',
        result_url: 'https://cdn.example.com/output.wav',
      },
    });
  };
  const submitted = await seedanceNz.submitAudioTask({
    prompt: 'soft analog synth pads with no vocals',
    outputFormat: 'wav',
    sampleRate: '24000',
  }, 'test-key', { baseUrl: 'https://api.seedance.nz', fetchImpl });
  const queried = await seedanceNz.queryAudioTask(submitted.taskId, 'test-key', {
    baseUrl: 'https://api.seedance.nz', fetchImpl,
  });
  assert.deepEqual(calls, [
    'https://api.seedance.nz/v1/audio/generations',
    'https://api.seedance.nz/v1/audio/generations/audio-task-1',
  ]);
  assert.equal(queried.status, 'succeeded');
  assert.equal(queried.audioUrl, 'https://cdn.example.com/output.wav');
});

function minimalVideoRequest() {
  return {
    model: 'mini',
    prompt: 'bounded provider response test',
    duration: 4,
    ratio: '16:9',
    resolution: '480p',
  };
}

async function capturedRejection(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error as Error & Record<string, unknown>;
  }
  assert.fail('expected promise to reject');
}

test('seedance.nz never reflects plain-text or JSON upstream secrets in errors', async () => {
  const apiKey = 'provider-json-key-should-never-leak';
  const plainSecret = 'provider-plain-secret-should-never-leak';
  const plainError = await capturedRejection(seedanceNz.submitTask(
    minimalVideoRequest(),
    apiKey,
    {
      fetchImpl: async () => new Response(plainSecret, {
        status: 502,
        headers: { 'x-request-id': 'req-plain-safe' },
      }),
    },
  ));

  assert.equal(plainError.code, 'SEEDANCE_INVALID_RESPONSE');
  assert.equal(plainError.status, 502);
  assert.equal(plainError.requestId, 'req-plain-safe');
  assert.match(String(plainError.bodyDigest), /^sha256:[a-f0-9]{16}$/);
  assert.doesNotMatch(`${plainError.message} ${JSON.stringify(plainError)}`, new RegExp(plainSecret));

  const jsonError = await capturedRejection(seedanceNz.submitTask(
    minimalVideoRequest(),
    apiKey,
    {
      fetchImpl: async () => jsonResponse({
        code: 'RATE_LIMITED',
        request_id: 'req-json-safe',
        error: { message: `Invalid API key: ${apiKey}` },
      }, 429),
    },
  ));

  assert.equal(jsonError.code, 'SEEDANCE_UPSTREAM_ERROR');
  assert.equal(jsonError.upstreamCode, 'RATE_LIMITED');
  assert.equal(jsonError.status, 429);
  assert.equal(jsonError.requestId, 'req-json-safe');
  assert.doesNotMatch(`${jsonError.message} ${JSON.stringify(jsonError)}`, new RegExp(apiKey));
});

test('seedance.nz failed task normalization omits raw provider messages and secrets', async () => {
  const secret = 'failed-task-provider-secret';
  const result = await seedanceNz.queryTask('task-safe', 'test-key', {
    fetchImpl: async () => jsonResponse({
      status: 'failed',
      progress: `50% ${secret}`,
      error: { message: `generation failed with ${secret}` },
      request_id: 'req-failed-safe',
    }),
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.failReason, 'Seedance 任务失败');
  assert.equal(result.progress, '');
  assert.equal(result.requestId, 'req-failed-safe');
  assert.equal('raw' in result, false);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
});

test('seedance.nz rejects oversized provider bodies before accumulation and cancels the stream', async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"id":"task-that-is-too-large"}'));
    },
    cancel() {
      cancelled = true;
    },
  });
  const error = await capturedRejection(seedanceNz.submitTask(
    minimalVideoRequest(),
    'test-key',
    {
      providerMaxResponseBytes: 16,
      fetchImpl: async () => new Response(body, {
        status: 200,
        headers: { 'Content-Length': '31' },
      }),
    },
  ));

  assert.equal(error.code, 'SEEDANCE_RESPONSE_TOO_LARGE');
  assert.equal(error.status, 502);
  assert.equal(error.maxBytes, 16);
  assert.equal(cancelled, true);
});

test('seedance.nz accepts transparently decoded compressed JSON but bounds decoded bytes', async () => {
  const decoded = JSON.stringify({ id: 'compressed-task' });
  const submitted = await seedanceNz.submitTask(minimalVideoRequest(), 'test-key', {
    providerMaxResponseBytes: 64,
    fetchImpl: async () => new Response(decoded, {
      status: 200,
      headers: {
        'Content-Encoding': 'gzip',
        'Content-Length': '9',
      },
    }),
  });
  assert.equal(submitted.taskId, 'compressed-task');

  const oversized = await capturedRejection(seedanceNz.submitTask(minimalVideoRequest(), 'test-key', {
    providerMaxResponseBytes: 16,
    fetchImpl: async () => new Response(decoded, {
      status: 200,
      headers: {
        'Content-Encoding': 'br',
        'Content-Length': '5',
      },
    }),
  }));
  assert.equal(oversized.code, 'SEEDANCE_RESPONSE_TOO_LARGE');
  assert.equal(oversized.maxBytes, 16);
});

test('seedance.nz enforces idle timeout while streaming and cancels the provider body', async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"id":'));
    },
    cancel() {
      cancelled = true;
    },
  });
  const startedAt = Date.now();
  const error = await capturedRejection(seedanceNz.submitTask(
    minimalVideoRequest(),
    'test-key',
    {
      providerDeadlineMs: 250,
      providerIdleTimeoutMs: 25,
      fetchImpl: async () => new Response(body, { status: 200 }),
    },
  ));

  assert.equal(error.code, 'SEEDANCE_UPSTREAM_TIMEOUT');
  assert.equal(error.status, 504);
  assert.equal(cancelled, true);
  assert.ok(Date.now() - startedAt < 500);
});

test('seedance.nz bounds response-header wait even when fetch ignores AbortSignal', async () => {
  let signal: AbortSignal | undefined;
  const startedAt = Date.now();
  const error = await capturedRejection(seedanceNz.submitTask(
    minimalVideoRequest(),
    'test-key',
    {
      providerDeadlineMs: 30,
      fetchImpl: async (_url: string, init?: RequestInit) => {
        signal = init?.signal || undefined;
        return await new Promise<Response>(() => {});
      },
    },
  ));

  assert.equal(error.code, 'SEEDANCE_UPSTREAM_TIMEOUT');
  assert.equal(error.status, 504);
  assert.equal(signal?.aborted, true);
  assert.ok(Date.now() - startedAt < 500);
});

test('seedance.nz localizes remote media before Provider upload', async (t) => {
  seedanceNz.resetCachesForTests();
  let originCalls = 0;
  let providerCalls = 0;
  const server = await listen((_req, res) => {
    originCalls += 1;
    const body = Buffer.from('tiny-png');
    res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': String(body.length) });
    res.end(body);
  });
  t.after(() => closeServer(server));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const source = `http://127.0.0.1:${address.port}/reference.png`;
  const result = await seedanceNz.uploadMedia(source, 'image', 'test-key', {
    maxBytes: 64,
    uploadIntervalMs: 0,
    allowPrivateForTests: (hostname: string) => hostname === '127.0.0.1',
    fetchImpl: async (url: string, init?: RequestInit) => {
      providerCalls += 1;
      assert.match(url, /\/v1\/files\/upload$/);
      assert.ok(init?.body instanceof FormData);
      return jsonResponse({ url: 'https://cdn.example.com/localized-reference.png' });
    },
  });

  assert.equal(result, 'https://cdn.example.com/localized-reference.png');
  assert.equal(originCalls, 1);
  assert.equal(providerCalls, 1);
  assert.notEqual(result, source);
});

test('seedance.nz rejects metadata, special-range IPv4, IPv6 local and credentialed media URLs before Provider upload', async () => {
  seedanceNz.resetCachesForTests();
  let providerCalls = 0;
  const blocked = [
    'http://169.254.169.254/latest/meta-data',
    'http://0.1.2.3/private.png',
    'http://100.64.0.1/private.png',
    'http://[fc00::1]/private.png',
    'http://[fe80::1]/private.png',
    'http://user:credential-secret@8.8.8.8/private.png',
  ];
  for (const source of blocked) {
    const error = await capturedRejection(seedanceNz.uploadMedia(source, 'image', 'test-key', {
      uploadIntervalMs: 0,
      fetchImpl: async () => {
        providerCalls += 1;
        return jsonResponse({ url: 'https://cdn.example.com/must-not-upload.png' });
      },
    }));
    assert.equal(error.code, 'SEEDANCE_REMOTE_MEDIA_BLOCKED', source);
    assert.equal(error.status, 400, source);
    if (source.includes('credential-secret')) {
      assert.match(error.message, /包含账号或密码/);
    } else {
      assert.match(error.message, /本机、局域网或受保护网络/);
    }
    assert.match(error.message, /重新上传原图片/);
    assert.match(error.message, /SEEDANCE_REMOTE_MEDIA_BLOCKED/);
    assert.doesNotMatch(`${error.message} ${JSON.stringify(error)}`, /credential-secret/);
  }
  const invalidSecret = 'invalid-media-reference-provider-secret';
  const invalidError = await capturedRejection(seedanceNz.uploadMedia(
    invalidSecret,
    'image',
    'test-key',
    {
      uploadIntervalMs: 0,
      fetchImpl: async () => {
        providerCalls += 1;
        return jsonResponse({ url: 'https://cdn.example.com/must-not-upload.png' });
      },
    },
  ));
  assert.equal(invalidError.code, 'SEEDANCE_MEDIA_REFERENCE_INVALID');
  assert.doesNotMatch(`${invalidError.message} ${JSON.stringify(invalidError)}`, new RegExp(invalidSecret));
  assert.equal(providerCalls, 0);
});

test('seedance.nz treats absolute loopback URLs on controlled T8 mounts as local uploaded media', async () => {
  seedanceNz.resetCachesForTests();
  const config = require('../backend/src/config.js');
  const fileName = `seedance-local-ref-${process.pid}-${Date.now()}.png`;
  const filePath = join(config.INPUT_DIR, fileName);
  mkdirSync(config.INPUT_DIR, { recursive: true });
  writeFileSync(filePath, Buffer.from('local-reference'));
  let providerCalls = 0;

  try {
    const result = await seedanceNz.uploadMedia(
      `http://127.0.0.1:11422/files/input/${fileName}?legacy=1`,
      'image',
      'test-key',
      {
        uploadIntervalMs: 0,
        fetchImpl: async (url: string, init?: RequestInit) => {
          providerCalls += 1;
          assert.match(url, /\/v1\/files\/upload$/);
          assert.ok(init?.body instanceof FormData);
          return jsonResponse({ url: 'https://cdn.example.com/local-ref.png' });
        },
      },
    );

    assert.equal(result, 'https://cdn.example.com/local-ref.png');
    assert.equal(providerCalls, 1);
  } finally {
    rmSync(filePath, { force: true });
  }
});

test('seedance.nz reports a missing controlled local file without attempting an SSRF fetch or Provider upload', async () => {
  seedanceNz.resetCachesForTests();
  let providerCalls = 0;
  const missing = `/files/output/seedance-missing-${process.pid}-${Date.now()}.png`;
  const error = await capturedRejection(seedanceNz.uploadMedia(
    `http://127.0.0.1:18766${missing}?cache=1`,
    'image',
    'test-key',
    {
      uploadIntervalMs: 0,
      fetchImpl: async () => {
        providerCalls += 1;
        return jsonResponse({ url: 'https://cdn.example.com/must-not-upload.png' });
      },
    },
  ));

  assert.equal(error.code, 'SEEDANCE_MEDIA_REFERENCE_UNAVAILABLE');
  assert.equal(error.status, 400);
  assert.match(error.message, /本地文件不存在或无法读取/);
  assert.match(error.message, /重新上传原图片/);
  assert.doesNotMatch(error.message, /127\.0\.0\.1|seedance-missing/);
  assert.equal(providerCalls, 0);
});

test('seedance.nz media download enforces byte limit during streaming and cancels before upload', async (t) => {
  seedanceNz.resetCachesForTests();
  let originCalls = 0;
  let providerCalls = 0;
  const server = await listen((_req, res) => {
    originCalls += 1;
    res.writeHead(200, { 'Content-Type': 'image/png', 'Transfer-Encoding': 'chunked' });
    res.write(Buffer.alloc(12, 1));
    setImmediate(() => {
      if (!res.destroyed) res.end(Buffer.alloc(12, 2));
    });
  });
  t.after(() => closeServer(server));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const error = await capturedRejection(seedanceNz.uploadMedia(
    `http://127.0.0.1:${address.port}/oversized.png`,
    'image',
    'test-key',
    {
      maxBytes: 16,
      uploadIntervalMs: 0,
      allowPrivateForTests: (hostname: string) => hostname === '127.0.0.1',
      fetchImpl: async () => {
        providerCalls += 1;
        return jsonResponse({ url: 'https://cdn.example.com/must-not-upload.png' });
      },
    },
  ));

  assert.equal(error.code, 'SEEDANCE_MEDIA_TOO_LARGE');
  assert.equal(error.status, 413);
  assert.equal(originCalls, 1);
  assert.equal(providerCalls, 0);
});
