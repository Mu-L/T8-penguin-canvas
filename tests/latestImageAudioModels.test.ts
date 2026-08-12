import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  IMAGE_MODELS,
  MUREKA_BGM_MODELS,
  MINIMAX_AUDIO_MODELS,
  QWEN3_TTS_MODELS,
  WAN27_GLOBAL_IMAGE_MODELS,
  ZHENZHEN_BUDGET_GROK_MODEL_OPTIONS,
} from '../src/providers/models.ts';

const require = createRequire(import.meta.url);
const provider = require('../backend/src/providers/seedanceNz.js');
const TINY_PNG = 'data:image/png;base64,iVBORw0KGgo=';
const TINY_MP3 = 'data:audio/mpeg;base64,SUQzAwAAAAA=';

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('latest image and audio model catalogs expose the exact requested IDs', () => {
  assert.ok(ZHENZHEN_BUDGET_GROK_MODEL_OPTIONS.some(({ value }) => value === 'zhenzhen-image-gk-v2'));
  assert.deepEqual([...WAN27_GLOBAL_IMAGE_MODELS], [
    'wan-2.7-global-t2i',
    'wan-2.7-global-i2i',
    'wan-2.7-global-i2i-pro',
  ]);
  assert.ok(IMAGE_MODELS.some(({ id, tabLabel }) => id === 'wan-image' && tabLabel === 'Wan Image'));
  assert.deepEqual([...QWEN3_TTS_MODELS], ['qwen3-tts-flash', 'qwen3-tts-instruct-flash']);
  assert.deepEqual([...MINIMAX_AUDIO_MODELS], [
    'minimax-music-2.6',
    'minimax-speech-2.8-hd',
    'minimax-speech-2.8-turbo',
    'minimax-voice-clone',
  ]);
  assert.deepEqual([...MUREKA_BGM_MODELS], ['mureka-v8-bgm', 'mureka-v9-bgm']);
});

test('image payloads follow the GK v2 and Wan 2.7 official contracts', async () => {
  const gk = await provider.buildImagePayload({
    model: 'zhenzhen-image-gk-v2',
    prompt: '电影感的蓝色陶瓷杯产品摄影',
    size: '16:9',
    n: 3,
  }, 'test-key');
  assert.deepEqual(gk, {
    model: 'zhenzhen-image-gk-v2',
    taskType: 't2i',
    payload: {
      model: 'zhenzhen-image-gk-v2',
      prompt: '电影感的蓝色陶瓷杯产品摄影',
      n: 3,
      size: '16:9',
    },
  });

  const wanT2i = await provider.buildImagePayload({
    model: 'wan-2.7-global-t2i',
    prompt: 'minimalist editorial portrait',
    width: 1536,
    height: 1024,
    thinkingMode: false,
  }, 'test-key');
  assert.deepEqual(wanT2i.payload, {
    model: 'wan-2.7-global-t2i',
    prompt: 'minimalist editorial portrait',
    metadata: { width: 1536, height: 1024, thinking_mode: false },
  });

  for (const model of ['wan-2.7-global-i2i', 'wan-2.7-global-i2i-pro']) {
    let uploads = 0;
    const built = await provider.buildImagePayload({
      model,
      prompt: 'retain the subject and change the lighting',
      images: [TINY_PNG],
    }, 'test-key', {
      uploadIntervalMs: 0,
      fetchImpl: async (url: string) => {
        assert.match(url, /\/v1\/files\/upload$/);
        uploads += 1;
        return jsonResponse({ url: `https://cdn.example.com/wan-${uploads}.png` });
      },
    });
    assert.equal(built.taskType, 'i2i');
    assert.deepEqual(built.payload, {
      model,
      prompt: 'retain the subject and change the lighting',
      images: ['https://cdn.example.com/wan-1.png'],
    });
  }
});

test('Qwen3-TTS, MiniMax and Mureka payloads preserve every documented field', async () => {
  const qwen = await provider.buildAudioPayload({
    model: 'qwen3-tts-instruct-flash',
    prompt: '欢迎使用音频节点。',
    voice: 'Cherry',
    languageType: 'Chinese',
    instructions: '温柔、自然、语速稍慢',
    optimizeInstructions: true,
  }, 'test-key');
  assert.deepEqual(qwen.payload, {
    model: 'qwen3-tts-instruct-flash',
    prompt: '欢迎使用音频节点。',
    metadata: {
      voice: 'Cherry',
      language_type: 'Chinese',
      instructions: '温柔、自然、语速稍慢',
      optimize_instructions: true,
    },
  });

  const music = await provider.buildAudioPayload({
    model: 'minimax-music-2.6',
    prompt: '温暖电影感的器乐配乐',
    isInstrumental: true,
    lyricsOptimizer: false,
    outputFormat: 'mp3',
    sampleRate: '44100',
    bitrate: '256000',
  }, 'test-key');
  assert.deepEqual(music.payload.metadata, {
    is_instrumental: true,
    lyrics_optimizer: false,
    format: 'mp3',
    sample_rate: '44100',
    bitrate: '256000',
  });

  for (const model of ['minimax-speech-2.8-hd', 'minimax-speech-2.8-turbo']) {
    const speech = await provider.buildAudioPayload({
      model,
      prompt: '这是一段清晰自然的语音。',
      voiceId: 'Wise_Woman',
      speed: 1.1,
      volume: 1.2,
      pitch: 1,
      languageBoost: 'Chinese',
      outputFormat: 'wav',
      sampleRate: '32000',
      bitrate: '128000',
      channel: 2,
    }, 'test-key');
    assert.deepEqual(speech.payload.metadata, {
      voice_id: 'Wise_Woman',
      speed: 1.1,
      vol: 1.2,
      pitch: 1,
      language_boost: 'Chinese',
      format: 'wav',
      sample_rate: '32000',
      bitrate: '128000',
      channel: 2,
    });
  }

  const clone = await provider.buildAudioPayload({
    model: 'minimax-voice-clone',
    prompt: '创建可复用音色',
    customVoiceId: 'CanvasVoice01',
    cloneTargetModel: 'minimax-speech-2.8-hd',
    needNoiseReduction: true,
    needVolumeNormalization: true,
    audioUrls: [TINY_MP3],
  }, 'test-key', {
    uploadIntervalMs: 0,
    fetchImpl: async () => jsonResponse({ url: 'https://cdn.example.com/reference.mp3' }),
  });
  assert.deepEqual(clone.payload.metadata, {
    audio_url: 'https://cdn.example.com/reference.mp3',
    custom_voice_id: 'CanvasVoice01',
    model: 'minimax-speech-2.8-hd',
    need_noise_reduction: true,
    need_volume_normalization: true,
  });

  for (const model of MUREKA_BGM_MODELS) {
    const mureka = await provider.buildAudioPayload({ model, prompt: '轻盈的原声吉他背景音乐', n: 3 }, 'test-key');
    assert.deepEqual(mureka.payload, {
      model,
      prompt: '轻盈的原声吉他背景音乐',
      metadata: { n: 3, stream: false },
    });
  }
});

test('audio task query keeps all Mureka results in upstream order and clone text output', async () => {
  const audio = await provider.queryAudioTask('task-audio', 'test-key', {
    fetchImpl: async () => jsonResponse({
      data: {
        status: 'completed',
        data: { content: { audio_urls: ['https://cdn.example.com/1.mp3', 'https://cdn.example.com/2.mp3', 'https://cdn.example.com/3.mp3'] } },
      },
    }),
  });
  assert.deepEqual(audio.audioUrls, [
    'https://cdn.example.com/1.mp3',
    'https://cdn.example.com/2.mp3',
    'https://cdn.example.com/3.mp3',
  ]);
  assert.equal(audio.audioUrl, 'https://cdn.example.com/1.mp3');

  const clone = await provider.queryAudioTask('task-clone', 'test-key', {
    fetchImpl: async () => jsonResponse({
      data: { status: 'completed', data: { content: { voice_id: 'CanvasVoice01' } } },
    }),
  });
  assert.equal(clone.resultText, 'CanvasVoice01');
  assert.deepEqual(clone.audioUrls, []);
});

test('all 12 importable workflows are saved without credentials', () => {
  const workflowModels = [
    'zhenzhen-image-gk-v2',
    ...WAN27_GLOBAL_IMAGE_MODELS,
    ...QWEN3_TTS_MODELS,
    ...MINIMAX_AUDIO_MODELS,
    ...MUREKA_BGM_MODELS,
  ];
  assert.equal(workflowModels.length, 12);
  for (const model of workflowModels) {
    const file = join(process.cwd(), 'docs', 'workflows', `${model}.json`);
    const source = readFileSync(file, 'utf8');
    const workflow = JSON.parse(source);
    assert.equal(workflow.schema, 't8-workflow-fragment');
    assert.equal(workflow.version, 1);
    assert.ok(Array.isArray(workflow.nodes) && workflow.nodes.length > 0);
    assert.ok(workflow.nodes.some((node: any) => node?.data?.apiModel === model || node?.data?.qwenTtsModel === model || node?.data?.minimaxAudioModel === model || node?.data?.murekaModel === model));
    assert.doesNotMatch(source, /sk-[A-Za-z0-9_-]+/);
  }
});

test('UI and backend routes wire the new tabs and materialize ordered audio outputs', () => {
  const audioNode = readFileSync(join(process.cwd(), 'src/components/nodes/AudioNode.tsx'), 'utf8');
  const imageNode = readFileSync(join(process.cwd(), 'src/components/nodes/ImageNode.tsx'), 'utf8');
  const proxy = readFileSync(join(process.cwd(), 'backend/src/routes/proxy.js'), 'utf8');
  for (const label of ['Qwen3-TTS', 'MiniMax', 'Mureka']) assert.match(audioNode, new RegExp(label));
  assert.match(imageNode, /Wan Image 2\.7 Global/);
  assert.match(proxy, /materializeSeedanceNzAudioResults/);
  assert.match(proxy, /audioUrls/);
});

test('creative runtime catalog assigns every new model to the budget-house authority', () => {
  const artifacts = require('../tools/zcanvas-cli/scripts/creativeRuntimeCatalogArtifacts.cjs');
  const catalog = artifacts.buildRuntimeCatalog();
  const models = [
    'zhenzhen-image-gk-v2',
    ...WAN27_GLOBAL_IMAGE_MODELS,
    ...QWEN3_TTS_MODELS,
    ...MINIMAX_AUDIO_MODELS,
    ...MUREKA_BGM_MODELS,
  ];
  for (const model of models) {
    const kind = AUDIO_MODELS_FOR_TEST.has(model) ? 'audio' : 'image';
    assert.ok(catalog[kind].some((entry: any) => entry.id === `${kind}:seedance-nz:${model}`));
    assert.ok(!catalog[kind].some((entry: any) => entry.id === `${kind}:zhenzhen:${model}`));
  }
  const wan = catalog.image.find((entry: any) => entry.id === 'image:seedance-nz:wan-2.7-global-i2i-pro');
  assert.equal(wan.family, 'wan-image');
  assert.equal(wan.parameters.maxReferenceImages, 9);
  const mureka = catalog.audio.find((entry: any) => entry.id === 'audio:seedance-nz:mureka-v9-bgm');
  assert.equal(mureka.parameters.orderedMultiOutput, true);
  assert.equal(mureka.parameters.maxOutputs, 3);
});

const AUDIO_MODELS_FOR_TEST = new Set([
  ...QWEN3_TTS_MODELS,
  ...MINIMAX_AUDIO_MODELS,
  ...MUREKA_BGM_MODELS,
]);
