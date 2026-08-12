'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const sharp = require('sharp');
const provider = require('../backend/src/providers/seedanceNz');

const root = path.resolve(__dirname, '..');
const runId = String(process.env.LATEST_IMAGE_AUDIO_LIVE_RUN || 'latest-image-audio-live-20260812').trim();
const outputDir = path.join(root, 'output', runId);
const reportFile = path.join(outputDir, 'report.json');
const privateStateFile = path.join(outputDir, 'state.private.json');
const ffmpeg = require('ffmpeg-static');
const pollIntervalMs = Math.max(1000, Number(process.env.LATEST_IMAGE_AUDIO_POLL_MS || 5000));
const timeoutMs = Math.max(60_000, Number(process.env.LATEST_IMAGE_AUDIO_TIMEOUT_MS || 60 * 60 * 1000));

const IMAGE_MODELS = [
  'zhenzhen-image-gk-v2',
  'wan-2.7-global-t2i',
  'wan-2.7-global-i2i',
  'wan-2.7-global-i2i-pro',
];
const AUDIO_MODELS = [
  'qwen3-tts-flash',
  'qwen3-tts-instruct-flash',
  'minimax-music-2.6',
  'minimax-speech-2.8-hd',
  'minimax-speech-2.8-turbo',
  'minimax-voice-clone',
  'mureka-v8-bgm',
  'mureka-v9-bgm',
];

function configuredApiKey() {
  const fromEnvironment = String(process.env.LATEST_IMAGE_AUDIO_API_KEY || '').trim();
  delete process.env.LATEST_IMAGE_AUDIO_API_KEY;
  if (fromEnvironment) return fromEnvironment;
  const settingsFile = path.join(root, 'data', 'settings.json');
  const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  const fromSettings = String(settings?.zhenzhenSd2ApiKey || '').trim();
  if (!fromSettings) throw new Error('本机设置中缺少贞贞的平价AI小屋 API Key');
  return fromSettings;
}

const apiKey = configuredApiKey();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function safeName(value) {
  return String(value || '').replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 100);
}

function readState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(privateStateFile, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : { models: {} };
  } catch (error) {
    if (error?.code === 'ENOENT') return { models: {} };
    throw error;
  }
}

function writeState(state) {
  fs.writeFileSync(privateStateFile, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
}

function submissionFetch(model, family) {
  const idempotencyKey = `t8-latest-media:${runId}:${model}`;
  return (url, init = {}) => {
    const method = String(init.method || 'GET').toUpperCase();
    const endpoint = String(url);
    const isSubmission = method === 'POST' && (
      (family === 'image' && /\/v1\/image\/generations\/?(?:\?|$)/.test(endpoint))
      || (family === 'audio' && /\/v1\/audio\/generations\/?(?:\?|$)/.test(endpoint))
    );
    return fetch(url, {
      ...init,
      headers: {
        ...(init.headers || {}),
        ...(isSubmission ? { 'Idempotency-Key': idempotencyKey } : {}),
      },
    });
  };
}

async function acceptedTask(model, family, request) {
  const state = readState();
  state.models ||= {};
  const existing = state.models[model];
  if (existing?.taskId && existing?.family === family) {
    process.stdout.write(`[latest-media] ${model} resume accepted task\n`);
    return existing.taskId;
  }
  process.stdout.write(`[latest-media] ${model} submit one paid task\n`);
  const options = {
    fetchImpl: submissionFetch(model, family),
    uploadIntervalMs: 0,
    uploadCacheTtlMs: 0,
  };
  const submitted = family === 'image'
    ? await provider.submitImageTask(request, apiKey, options)
    : await provider.submitAudioTask(request, apiKey, options);
  state.models[model] = {
    family,
    taskId: submitted.taskId,
    acceptedAt: new Date().toISOString(),
  };
  writeState(state);
  process.stdout.write(`[latest-media] ${model} accepted\n`);
  return submitted.taskId;
}

async function pollTask(model, family, taskId) {
  const startedAt = Date.now();
  let lastStatus = '';
  let transientFailures = 0;
  while (Date.now() - startedAt < timeoutMs) {
    let result;
    try {
      result = family === 'image'
        ? await provider.queryImageTask(taskId, apiKey)
        : await provider.queryAudioTask(taskId, apiKey);
      transientFailures = 0;
    } catch (error) {
      transientFailures += 1;
      if (transientFailures >= 5) throw error;
      await sleep(pollIntervalMs);
      continue;
    }
    const statusLine = `${result.status}:${result.progress || ''}`;
    if (statusLine !== lastStatus) process.stdout.write(`[latest-media] ${model} ${statusLine}\n`);
    lastStatus = statusLine;
    if (result.status === 'succeeded') return result;
    if (result.status === 'failed') throw new Error(`${model} failed: ${result.failReason || 'upstream task failed'}`);
    await sleep(pollIntervalMs);
  }
  throw new Error(`${model} polling timed out; accepted task was not replayed`);
}

function extensionForContentType(contentType, family) {
  const mime = String(contentType || '').split(';')[0].trim().toLowerCase();
  const known = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'audio/mpeg': 'mp3',
    'audio/mp3': 'mp3',
    'audio/wav': 'wav',
    'audio/x-wav': 'wav',
    'audio/flac': 'flac',
    'audio/ogg': 'ogg',
    'audio/mp4': 'm4a',
  };
  return known[mime] || (family === 'image' ? 'img' : 'audio');
}

async function downloadImage(model, url, index) {
  const response = await provider.fetchRemote(url);
  if (!response.ok) throw new Error(`${model} output ${index + 1} download HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length < 1024) throw new Error(`${model} output ${index + 1} is unexpectedly small`);
  const metadata = await sharp(buffer, { failOn: 'error' }).metadata();
  if (!metadata.width || !metadata.height || !metadata.format) throw new Error(`${model} output ${index + 1} is not a decodable image`);
  const extension = metadata.format === 'jpeg' ? 'jpg' : metadata.format;
  const file = path.join(outputDir, `${safeName(model)}-${String(index + 1).padStart(2, '0')}.${extension}`);
  fs.writeFileSync(file, buffer);
  return {
    index,
    file: path.relative(root, file).replace(/\\/g, '/'),
    bytes: buffer.length,
    sha256: sha256(buffer),
    format: metadata.format,
    width: metadata.width,
    height: metadata.height,
  };
}

async function downloadAudio(model, url, index) {
  const response = await provider.fetchRemote(url);
  if (!response.ok) throw new Error(`${model} output ${index + 1} download HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length < 1024) throw new Error(`${model} output ${index + 1} is unexpectedly small`);
  const extension = extensionForContentType(response.headers.get('content-type'), 'audio');
  const file = path.join(outputDir, `${safeName(model)}-${String(index + 1).padStart(2, '0')}.${extension}`);
  fs.writeFileSync(file, buffer);
  try {
    execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', file, '-f', 'null', '-'], {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
      timeout: 120_000,
    });
  } catch (error) {
    const diagnostic = String(error?.stderr || error?.message || error).replaceAll(apiKey, '[REDACTED]').slice(0, 300);
    throw new Error(`${model} output ${index + 1} failed media decode: ${diagnostic}`);
  }
  return {
    index,
    file: path.relative(root, file).replace(/\\/g, '/'),
    bytes: buffer.length,
    sha256: sha256(buffer),
    decoder: 'ffmpeg',
  };
}

async function verifyImage(model, request) {
  const taskId = await acceptedTask(model, 'image', request);
  const result = await pollTask(model, 'image', taskId);
  const urls = Array.isArray(result.imageUrls) && result.imageUrls.length
    ? result.imageUrls.filter(Boolean)
    : [result.imageUrl].filter(Boolean);
  if (!urls.length) throw new Error(`${model} succeeded without image output`);
  const outputs = [];
  for (let index = 0; index < urls.length; index += 1) outputs.push(await downloadImage(model, urls[index], index));
  return { remoteUrls: urls, report: { model, status: 'passed', outputCount: urls.length, outputs } };
}

async function verifyAudio(model, request, minimumOutputs = 1) {
  const taskId = await acceptedTask(model, 'audio', request);
  const result = await pollTask(model, 'audio', taskId);
  const urls = Array.isArray(result.audioUrls) && result.audioUrls.length
    ? result.audioUrls.filter(Boolean)
    : [result.audioUrl].filter(Boolean);
  if (urls.length < minimumOutputs) throw new Error(`${model} returned ${urls.length} audio outputs; expected at least ${minimumOutputs}`);
  const outputs = [];
  for (let index = 0; index < urls.length; index += 1) outputs.push(await downloadAudio(model, urls[index], index));
  const resultText = String(result.resultText || '').trim();
  return {
    remoteUrls: urls,
    resultText,
    report: {
      model,
      status: 'passed',
      outputCount: urls.length,
      preservedProviderOrder: true,
      resultTextLength: resultText.length,
      resultTextSha256: resultText ? sha256(Buffer.from(resultText)) : null,
      outputs,
    },
  };
}

async function verifyClone(referenceAudioUrl) {
  const model = 'minimax-voice-clone';
  const deterministicVoiceId = `CanvasVoice${sha256(Buffer.from(runId)).slice(0, 12)}`;
  const taskId = await acceptedTask(model, 'audio', {
    model,
    prompt: 'Create a reusable voice profile from the supplied reference audio.',
    customVoiceId: deterministicVoiceId,
    cloneTargetModel: 'minimax-speech-2.8-hd',
    needNoiseReduction: true,
    needVolumeNormalization: true,
    audioUrls: [referenceAudioUrl],
  });
  const result = await pollTask(model, 'audio', taskId);
  const resultText = String(result.resultText || '').trim();
  const urls = Array.isArray(result.audioUrls) ? result.audioUrls.filter(Boolean) : [];
  if (!resultText && !urls.length) throw new Error(`${model} succeeded without a voice ID or audio output`);
  const outputs = [];
  for (let index = 0; index < urls.length; index += 1) outputs.push(await downloadAudio(model, urls[index], index));
  return {
    model,
    status: 'passed',
    outputCount: outputs.length,
    resultTextLength: resultText.length,
    resultTextSha256: resultText ? sha256(Buffer.from(resultText)) : null,
    outputs,
  };
}

async function main() {
  fs.mkdirSync(outputDir, { recursive: true });
  const report = {
    schema: 't8-latest-image-audio-live-verification-v1',
    runId,
    checkedAt: new Date().toISOString(),
    provider: 'seedance-nz',
    officialDocs: {
      url: 'https://api.seedance.nz/docs/llms.txt',
      lastModified: 'Tue, 11 Aug 2026 21:03:05 GMT',
      bytes: 647218,
      sha256: '9088f0a28ff140b2bc754b7938c8bb8d7155ace5a861b24ffc8d40fb0a7ea84c',
    },
    referenceImplementation: 'F:/AI-T8-video-onekey/ComfyUI/custom_nodes/ComfyUI_Seedance@38041c0492',
    credentialsPersisted: false,
    taskIdsPersistedInReport: false,
    remoteUrlsPersistedInReport: false,
    models: [],
  };

  const gk = await verifyImage('zhenzhen-image-gk-v2', {
    model: 'zhenzhen-image-gk-v2',
    prompt: 'A clean cinematic product photograph of a blue ceramic cup on a pale stone table, soft daylight, crisp silhouette.',
    size: '1:1',
    n: 1,
  });
  report.models.push(gk.report);

  const wanT2i = await verifyImage('wan-2.7-global-t2i', {
    model: 'wan-2.7-global-t2i',
    prompt: 'Editorial still life of a sculptural glass vase, soft window light, neutral studio background, realistic materials.',
    width: 1024,
    height: 1024,
    thinkingMode: true,
  });
  report.models.push(wanT2i.report);

  for (const model of ['wan-2.7-global-i2i', 'wan-2.7-global-i2i-pro']) {
    const wan = await verifyImage(model, {
      model,
      prompt: 'Keep the original object identity and silhouette. Change the scene into a premium editorial studio with warm rim light.',
      images: [gk.remoteUrls[0]],
    });
    report.models.push(wan.report);
  }

  const qwenReferenceText = '欢迎来到贞贞的无限画布。这里的每一个节点都可以连接灵感、素材与模型，让复杂的创作过程变得清晰而自然。请用平稳、亲切、略带微笑的语气朗读，并在句号处保留自然停顿。今天我们将完成一段足够长的参考语音，用于验证音频生成、文件下载、媒体解码和声音克隆的完整链路。';
  const qwenFlash = await verifyAudio('qwen3-tts-flash', {
    model: 'qwen3-tts-flash',
    prompt: qwenReferenceText,
    voice: 'Cherry',
    languageType: 'Chinese',
  });
  report.models.push(qwenFlash.report);

  const qwenInstruct = await verifyAudio('qwen3-tts-instruct-flash', {
    model: 'qwen3-tts-instruct-flash',
    prompt: '一阵轻柔的风穿过树梢，城市在清晨的光线中慢慢醒来。',
    voice: 'Cherry',
    languageType: 'Chinese',
    instructions: '温柔、自然、语速稍慢，结尾轻轻收住',
    optimizeInstructions: true,
  });
  report.models.push(qwenInstruct.report);

  const minimaxMusic = await verifyAudio('minimax-music-2.6', {
    model: 'minimax-music-2.6',
    prompt: 'Warm cinematic instrumental music with piano, soft strings and a gentle emotional build, suitable for a short film.',
    isInstrumental: true,
    lyricsOptimizer: false,
    outputFormat: 'mp3',
    sampleRate: '44100',
    bitrate: '128000',
  });
  report.models.push(minimaxMusic.report);

  for (const model of ['minimax-speech-2.8-hd', 'minimax-speech-2.8-turbo']) {
    const speech = await verifyAudio(model, {
      model,
      prompt: '这是一段用于验证语音模型、下载链路和媒体解码的清晰中文旁白。',
      voiceId: 'Wise_Woman',
      speed: 1,
      volume: 1,
      pitch: 0,
      languageBoost: 'Chinese',
      outputFormat: 'mp3',
      sampleRate: '32000',
      bitrate: '128000',
      channel: 1,
    });
    report.models.push(speech.report);
  }

  report.models.push(await verifyClone(qwenFlash.remoteUrls[0]));

  const murekaV8 = await verifyAudio('mureka-v8-bgm', {
    model: 'mureka-v8-bgm',
    prompt: 'Warm acoustic guitar background music with light percussion, optimistic and unobtrusive.',
    n: 1,
  });
  report.models.push(murekaV8.report);

  const murekaV9 = await verifyAudio('mureka-v9-bgm', {
    model: 'mureka-v9-bgm',
    prompt: 'Minimal modern cinematic background music with airy synth pads and a restrained emotional arc.',
    n: 2,
  }, 2);
  report.models.push(murekaV9.report);

  report.passed = report.models.length === IMAGE_MODELS.length + AUDIO_MODELS.length
    && report.models.every((entry) => entry.status === 'passed');
  report.checkedAt = new Date().toISOString();
  fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  if (report.passed && fs.existsSync(privateStateFile)) fs.rmSync(privateStateFile, { force: true });
  process.stdout.write(`[latest-media] verified ${report.models.length}/${IMAGE_MODELS.length + AUDIO_MODELS.length}; sanitized report saved\n`);
  if (!report.passed) process.exitCode = 1;
}

main().catch((error) => {
  const message = String(error?.message || error).replaceAll(apiKey, '[REDACTED]').replace(/https?:\/\/\S+/g, '[REDACTED_URL]').slice(0, 800);
  process.stderr.write(`[latest-media] ${message}\n`);
  process.exitCode = 1;
});
