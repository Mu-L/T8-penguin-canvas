import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

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
  const built = await seedanceNz.buildPayload({
    model: 'standard',
    prompt: 'A calm camera move',
    duration: 5,
    ratio: '16:9',
    resolution: 'native4K',
    firstFrame: 'https://assets.example.com/first.png',
    lastFrame: 'https://assets.example.com/last.png',
  }, 'test-key', { uploadIntervalMs: 0 });

  assert.equal(built.taskType, 'i2v');
  assert.equal(built.model, 'seedance-2.0-standard-i2v');
  assert.deepEqual(built.payload.images, [
    'https://assets.example.com/first.png',
    'https://assets.example.com/last.png',
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

test('seedance.nz selects the documented Dola Seedream overseas t2i and i2i models', async () => {
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
    images: ['https://assets.example.com/lighthouse.png'],
    resolution: '2k',
    output_format: 'jpeg',
  }, 'test-key');
  assert.equal(i2i.model, 'dola-seedream-5.0-pro-i2i');
  assert.equal(i2i.payload.model, 'dola-seedream-5.0-pro-i2i');
  assert.deepEqual(i2i.payload.images, ['https://assets.example.com/lighthouse.png']);
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
  const t2v = await seedanceNz.buildHappyHorsePayload({
    model: 'happyhorse-1.1-t2v',
    prompt: 'A paper horse runs through a miniature city',
    duration: 3,
    resolution: '720p',
    ratio: '16:9',
    images: ['https://assets.example.com/ignored.png'],
  }, 'test-key');
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
    images: ['https://assets.example.com/first.png', 'https://assets.example.com/ignored.png'],
  }, 'test-key');
  assert.equal(i2v.taskType, 'i2v');
  assert.deepEqual(i2v.payload.images, ['https://assets.example.com/first.png']);

  const r2v = await seedanceNz.buildHappyHorsePayload({
    model: 'happyhorse-1.1-r2v',
    prompt: '图1 的角色采用图2 的服装',
    duration: 15,
    resolution: '720p',
    ratio: '9:16',
    images: ['https://assets.example.com/one.png', 'https://assets.example.com/two.png'],
  }, 'test-key');
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

test('seedance.nz builds and submits the documented Wan 2.7 Spicy i2v payload', async () => {
  const built = await seedanceNz.buildWanPayload({
    model: 'wan-2.7-spicy-i2v',
    prompt: 'the character turns toward the camera',
    duration: 2,
    resolution: '1080p',
    images: ['https://assets.example.com/first.png', 'https://assets.example.com/ignored.png'],
    negativePrompt: 'blurry, distorted hands',
    audioUrl: 'https://assets.example.com/music.mp3',
    promptExtend: true,
    seed: 42,
  }, 'test-key');
  assert.deepEqual(built.payload, {
    model: 'wan-2.7-spicy-i2v',
    prompt: 'the character turns toward the camera',
    seconds: '2',
    images: ['https://assets.example.com/first.png'],
    metadata: {
      resolution: '1080p',
      negative_prompt: 'blurry, distorted hands',
      audio_url: 'https://assets.example.com/music.mp3',
      prompt_extend: true,
      seed: 42,
    },
  });

  const calls: string[] = [];
  const fetchImpl = async (url: string) => {
    calls.push(url);
    return jsonResponse({ id: 'wan-task-1', status: 'queued' });
  };
  const submitted = await seedanceNz.submitWanTask({
    model: 'wan-2.7-spicy-i2v',
    duration: 15,
    resolution: '720p',
    images: ['https://assets.example.com/first.png'],
  }, 'test-key', { baseUrl: 'https://api.seedance.nz', fetchImpl });
  assert.equal(submitted.taskId, 'wan-task-1');
  assert.equal(calls[0], 'https://api.seedance.nz/v1/videos');

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
