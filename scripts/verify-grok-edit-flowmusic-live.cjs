'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const sharp = require('sharp');
const ffmpeg = require('ffmpeg-static');
const provider = require('../backend/src/providers/seedanceNz');

const root = path.resolve(__dirname, '..');
const runId = String(process.env.GROK_FLOWMUSIC_LIVE_RUN || 'grok-flowmusic-live-20260821').trim();
const outputDir = path.join(root, 'output', runId);
const privateStateFile = path.join(outputDir, 'state.private.json');
const reportFile = path.join(outputDir, 'report.json');
const pollMs = Math.max(1000, Number(process.env.GROK_FLOWMUSIC_POLL_MS || 5000));
const timeoutMs = Math.max(60_000, Number(process.env.GROK_FLOWMUSIC_TIMEOUT_MS || 60 * 60 * 1000));

function configuredApiKey() {
  const fromEnvironment = String(process.env.GROK_FLOWMUSIC_API_KEY || '').trim();
  delete process.env.GROK_FLOWMUSIC_API_KEY;
  if (fromEnvironment) return fromEnvironment;
  const settings = JSON.parse(fs.readFileSync(path.join(root, 'data', 'settings.json'), 'utf8'));
  const value = String(settings?.zhenzhenSd2ApiKey || '').trim();
  if (!value) throw new Error('本机设置中缺少贞贞的平价AI小屋 API Key');
  return value;
}

const apiKey = configuredApiKey();
fs.mkdirSync(outputDir, { recursive: true });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');
const safeName = (value) => String(value || '').replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 100);

function decodeMedia(file) {
  const args = ['-hide_banner', '-loglevel', 'error', '-i', file, '-f', 'null', '-'];
  try {
    execFileSync(ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, timeout: 180_000 });
    return 'ffmpeg-static';
  } catch (bundledError) {
    if (process.platform !== 'win32') throw bundledError;
    execFileSync('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, timeout: 180_000 });
    return 'system-ffmpeg-fallback';
  }
}

function readState() {
  try {
    const value = JSON.parse(fs.readFileSync(privateStateFile, 'utf8'));
    return value && typeof value === 'object' ? value : { tasks: {} };
  } catch (error) {
    if (error?.code === 'ENOENT') return { tasks: {} };
    throw error;
  }
}

function writeState(state) {
  fs.writeFileSync(privateStateFile, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
}

function fetchWithIdempotency(name, kind, attempt) {
  return (url, init = {}) => {
    const endpoint = String(url);
    const method = String(init.method || 'GET').toUpperCase();
    const isSubmission = method === 'POST' && (
      (kind === 'image' && /\/v1\/image\/generations\/?$/.test(endpoint))
      || (kind === 'flowmusic' && /\/v1\/music\/generations(?:\/[^/?]+)?\/?$/.test(endpoint))
    );
    return fetch(endpoint, {
      ...init,
      headers: {
        ...(init.headers || {}),
        ...(isSubmission ? { 'Idempotency-Key': `t8:${runId}:${name}:${attempt}` } : {}),
      },
    });
  };
}

async function accepted(name, kind, submit) {
  const state = readState();
  state.tasks ||= {};
  if (state.tasks[name]?.taskId && state.tasks[name]?.failed !== true) {
    process.stdout.write(`[live] ${name} resume accepted task\n`);
    return state.tasks[name].taskId;
  }
  const attempt = Math.max(1, Number(state.tasks[name]?.attempt || 0) + 1);
  process.stdout.write(`[live] ${name} submit one task\n`);
  const result = await submit(fetchWithIdempotency(name, kind, attempt));
  if (!result.taskId) throw new Error(`${name} 未返回 task_id`);
  state.tasks[name] = { taskId: result.taskId, attempt, acceptedAt: new Date().toISOString(), failed: false };
  writeState(state);
  process.stdout.write(`[live] ${name} accepted\n`);
  return result.taskId;
}

async function poll(name, query) {
  const started = Date.now();
  let last = '';
  let failures = 0;
  while (Date.now() - started < timeoutMs) {
    try {
      const result = await query();
      failures = 0;
      const status = String(result.status || '').toLowerCase();
      const line = `${status}:${result.progress || ''}`;
      if (line !== last) process.stdout.write(`[live] ${name} ${line}\n`);
      last = line;
      if (status === 'succeeded') return result;
      if (status === 'failed') {
        const state = readState();
        if (state.tasks?.[name]) {
          state.tasks[name].failed = true;
          state.tasks[name].failedAt = new Date().toISOString();
          writeState(state);
        }
        const failure = new Error(`${name} 上游任务失败`);
        failure.terminal = true;
        throw failure;
      }
    } catch (error) {
      if (error?.terminal) throw error;
      failures += 1;
      if (failures >= 5) throw error;
    }
    await sleep(pollMs);
  }
  throw new Error(`${name} 轮询超时；已接受任务不会重复提交`);
}

async function download(url, name, family, index = 0) {
  const response = await provider.fetchRemote(url);
  if (!response.ok) throw new Error(`${name} 下载 HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length < 32) throw new Error(`${name} 下载结果过小`);
  let extension = family === 'image' ? 'png' : family === 'video' ? 'mp4' : family === 'file' ? 'zip' : 'mp3';
  let details = {};
  if (family === 'image') {
    const metadata = await sharp(buffer, { failOn: 'error' }).metadata();
    if (!metadata.width || !metadata.height || !metadata.format) throw new Error(`${name} 图片无法完整解码`);
    extension = metadata.format === 'jpeg' ? 'jpg' : metadata.format;
    details = { width: metadata.width, height: metadata.height, format: metadata.format, decoder: 'sharp' };
  } else if (family === 'file') {
    const zip = buffer[0] === 0x50 && buffer[1] === 0x4b;
    if (!zip) throw new Error(`${name} 结果不是 ZIP 文件`);
    details = { format: 'zip', signatureVerified: true };
  } else {
    const contentType = String(response.headers.get('content-type') || '').toLowerCase();
    if (family === 'audio') {
      const isWav = buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WAVE';
      if (isWav || contentType.includes('wav')) extension = 'wav';
      else if (contentType.includes('flac')) extension = 'flac';
      else if (contentType.includes('ogg')) extension = 'ogg';
      else if (contentType.includes('mp4')) extension = 'm4a';
    }
    const tempFile = path.join(outputDir, `${safeName(name)}-${index + 1}.${extension}`);
    fs.writeFileSync(tempFile, buffer);
    details = { decoder: decodeMedia(tempFile) };
    return { file: path.relative(root, tempFile).replace(/\\/g, '/'), bytes: buffer.length, sha256: sha256(buffer), ...details };
  }
  const file = path.join(outputDir, `${safeName(name)}-${index + 1}.${extension}`);
  fs.writeFileSync(file, buffer);
  return { file: path.relative(root, file).replace(/\\/g, '/'), bytes: buffer.length, sha256: sha256(buffer), ...details };
}

async function verifyImageEdit(reference) {
  const name = 'zhenzhen-image-gk-v2-edit';
  const taskId = await accepted(name, 'image', (fetchImpl) => provider.submitImageTask({
    model: name,
    prompt: 'Keep the centered geometric subject and transform the lighting into a cinematic blue-and-amber studio scene.',
    images: [reference],
    aspect_ratio: '1:1',
    resolution: '1k',
    n: 1,
    nsfw_check: false,
  }, apiKey, { fetchImpl, uploadIntervalMs: 0, uploadCacheTtlMs: 0 }));
  const result = await poll(name, () => provider.queryImageTask(taskId, apiKey));
  const urls = (result.imageUrls?.length ? result.imageUrls : [result.imageUrl]).filter(Boolean);
  if (!urls.length) throw new Error(`${name} 完成但无图片`);
  return { name, family: 'image', status: 'passed', outputs: [await download(urls[0], name, 'image')] };
}

async function verifyFlow(operation, request) {
  const spec = provider.FLOWMUSIC_ACTION_SPECS[operation];
  const taskId = await accepted(operation, 'flowmusic', (fetchImpl) => provider.submitFlowMusicTask({ operation, ...request }, apiKey, {
    fetchImpl, uploadIntervalMs: 0, uploadCacheTtlMs: 0,
  }));
  const result = await poll(operation, () => provider.queryFlowMusicTask(taskId, apiKey, { resultFamily: spec.resultFamily }));
  const clipIds = Array.isArray(result.clipIds) ? result.clipIds.filter(Boolean) : [];
  const urls = spec.resultFamily === 'video'
    ? result.artifacts.filter((item) => item.kind === 'video').map((item) => item.url)
    : spec.resultFamily === 'file'
      ? result.artifacts.filter((item) => item.kind === 'file').map((item) => item.url)
      : result.artifacts.filter((item) => item.kind === 'audio').map((item) => item.url);
  const report = { name: operation, family: spec.resultFamily, status: 'passed', clipIdReturned: clipIds.length > 0, outputCount: 0, outputs: [] };
  if (spec.resultFamily === 'text') {
    const text = String(result.text || '').trim();
    if (!text) throw new Error(`${operation} 完成但无歌词文本`);
    report.outputCount = 1;
    report.textLength = text.length;
    report.textSha256 = sha256(Buffer.from(text));
  } else {
    if (!urls.length) throw new Error(`${operation} 完成但无 ${spec.resultFamily} 结果`);
    for (let index = 0; index < urls.length; index += 1) {
      report.outputs.push(await download(urls[index], operation, spec.resultFamily, index));
    }
    report.outputCount = report.outputs.length;
  }
  return { result, report };
}

async function main() {
  const referenceBuffer = await sharp({
    create: { width: 768, height: 768, channels: 4, background: { r: 26, g: 31, b: 48, alpha: 1 } },
  }).composite([{ input: Buffer.from('<svg width="768" height="768" xmlns="http://www.w3.org/2000/svg"><rect x="184" y="184" width="400" height="400" rx="70" fill="#58c7ff"/><circle cx="384" cy="384" r="120" fill="#ffb454"/></svg>'), top: 0, left: 0 }]).png().toBuffer();
  const reference = `data:image/png;base64,${referenceBuffer.toString('base64')}`;
  const reports = [await verifyImageEdit(reference)];

  const generation = await verifyFlow('flowmusic-generation', {
    version: 'lyria-3.5',
    sound_prompt: 'cinematic instrumental pop, warm piano, restrained electronic pulse, no vocals',
    bpm: 110,
    length: 8,
    seed: 20260821,
  });
  reports.push(generation.report);
  const generatedClip = generation.result.clipIds?.[0];
  const generatedAudio = generation.result.artifacts.find((item) => item.kind === 'audio')?.url;
  if (!generatedClip || !generatedAudio) throw new Error('flowmusic-generation 未返回后续测试所需 clip_id/audio_url');

  reports.push((await verifyFlow('flowmusic-lyrics', { prompt: '写一段关于雨夜重逢与重新出发的简短中文流行歌词' })).report);
  const imported = await verifyFlow('flowmusic-upload-audio', { audioUrl: generatedAudio });
  reports.push(imported.report);
  const sourceClip = generatedClip || imported.result.clipIds?.[0];
  if (!sourceClip) throw new Error('flowmusic-upload-audio 未返回 clip_id');

  reports.push((await verifyFlow('flowmusic-extend', { version: 'lyria-3.5', clip_id: sourceClip, extend_from_s: 0, extend_s: 5, instruction: 'continue naturally with warm strings', seed: 20260821 })).report);
  reports.push((await verifyFlow('flowmusic-replace', { version: 'lyria-3.5', clip_id: sourceClip, start_s: 0, end_s: 2, instruction: 'replace with a gentle piano transition', seed: 20260821 })).report);
  reports.push((await verifyFlow('flowmusic-cover', { version: 'lyria-3.5', clip_id: sourceClip, instruction: 'cinematic acoustic cover with intimate piano', strength: 0.5, seed: 20260821 })).report);
  reports.push((await verifyFlow('flowmusic-stems', { clip_id: sourceClip })).report);
  reports.push((await verifyFlow('flowmusic-download-audio', { clip_id: sourceClip, format: 'wav' })).report);
  reports.push((await verifyFlow('flowmusic-video-clip', { clip_id: sourceClip, preset: 'modern' })).report);

  const report = {
    schema: 't8-grok-flowmusic-live-verification-v1',
    verifiedAt: new Date().toISOString(),
    provider: 'seedance-nz',
    channel: '贞贞的平价AI小屋',
    taskCount: reports.length,
    allPassed: reports.every((item) => item.status === 'passed'),
    secretFree: true,
    taskIdsOmitted: true,
    remoteUrlsOmitted: true,
    results: reports,
  };
  fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`[live] complete ${reports.length}/${reports.length}; report=${path.relative(root, reportFile)}\n`);
}

main().catch((error) => {
  const message = String(error?.stack || error?.message || error).replaceAll(apiKey, '[REDACTED]');
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
