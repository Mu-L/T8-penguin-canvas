const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const sharp = require('sharp');
const seedanceNz = require('../backend/src/providers/seedanceNz');

const apiKey = String(process.env.SEEDANCE_NZ_API_KEY || '').trim();
if (!apiKey) {
  console.error('SEEDANCE_NZ_API_KEY is required');
  process.exit(2);
}

const root = path.resolve(__dirname, '..');
const ffmpeg = path.join(root, 'tools', 'ffmpeg-runtime', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
const ffprobe = path.join(root, 'tools', 'ffmpeg-runtime', process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
const runName = String(process.env.QWEN_MINIMAX_LIVE_RUN || 'qwen-minimax-live-20260806').trim();
const outputDir = path.join(root, 'output', runName);
const stateFile = path.join(outputDir, 'state.private.json');
const reportFile = path.join(outputDir, 'report.json');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 't8-qwen-minimax-'));
fs.mkdirSync(outputDir, { recursive: true });

const qwenModels = [
  'qwen-image-3.0-t2i',
  'qwen-image-3.0-i2i',
  'qwen-image-3.0-pro-t2i',
  'qwen-image-3.0-pro-i2i',
  'qwen-image-3.0-global-t2i',
  'qwen-image-3.0-global-i2i',
  'qwen-image-3.0-global-pro-t2i',
  'qwen-image-3.0-global-pro-i2i',
];
const minimaxModels = [
  'minimax-h3-ow-t2v',
  'minimax-h3-ow-r2v',
  'minimax-h3-ow-i2v',
];
const allModels = [...qwenModels, ...minimaxModels];

function run(command, args, label) {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) {
    throw new Error(`${label} failed: ${(result.stderr || result.stdout || '').trim().slice(0, 500)}`);
  }
  return result.stdout;
}

function createReferenceImage() {
  if (!fs.existsSync(ffmpeg)) throw new Error('ffmpeg runtime is missing');
  const file = path.join(tempDir, 'reference.png');
  run(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=0x1f6aa5:s=768x768:d=0.1',
    '-vf', 'drawbox=x=190:y=170:w=388:h=428:color=0xf0cf84:t=fill,drawbox=x=258:y=238:w=252:h=292:color=0x28364f:t=fill',
    '-frames:v', '1', file,
  ], 'reference fixture');
  return file;
}

function loadState() {
  if (!fs.existsSync(stateFile)) return { tasks: {} };
  const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  return parsed && typeof parsed === 'object' && parsed.tasks ? parsed : { tasks: {} };
}

function saveState(state) {
  fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`);
}

function applyExplicitRetry(state) {
  const retryToken = String(process.env.QWEN_MINIMAX_RETRY_TOKEN || '').trim();
  const retryModels = String(process.env.QWEN_MINIMAX_RETRY_MODELS || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  if (!retryToken || retryModels.length === 0) return;
  if (retryModels.some((model) => !allModels.includes(model))) throw new Error('retry model is outside the verified catalog');
  state.appliedRetryTokens ||= {};
  if (state.appliedRetryTokens[retryToken]) return;
  state.history ||= {};
  for (const model of retryModels) {
    if (!state.tasks[model]?.taskId) throw new Error(`${model} has no previous accepted task to retry`);
    state.history[model] ||= [];
    state.history[model].push(state.tasks[model]);
    delete state.tasks[model];
  }
  state.appliedRetryTokens[retryToken] = retryModels;
  saveState(state);
}

function imageRequest(model, referenceImage) {
  return {
    model,
    prompt: model.endsWith('-i2i')
      ? 'Transform the reference into a clean cinematic product key visual with coherent lighting and no text.'
      : 'A clean cinematic product key visual of a geometric paper sculpture in a blue studio, coherent lighting, no text.',
    sizing_mode: 'ratio',
    ratio: '1:1',
    resolution: '1k',
    n: 1,
    seed: 20260806,
    prompt_extend: true,
    ...(model.endsWith('-i2i') ? { images: [referenceImage] } : {}),
  };
}

function videoRequest(model, referenceImage) {
  const prompt = model.endsWith('-i2v')
    ? 'The geometric subject gently rotates while the camera slowly pushes in, coherent lighting, no text.'
    : model.endsWith('-r2v')
      ? 'Preserve the reference subject identity while it gently rotates and the camera slowly pushes in, coherent lighting, no text.'
      : 'A geometric paper sculpture gently rotates in a blue studio while the camera slowly pushes in, coherent lighting, no text.';
  return {
    model,
    prompt,
    duration: 5,
    resolution: '480p',
    ratio: '16:9',
    ...(model.endsWith('-t2v') ? {} : { images: [referenceImage] }),
  };
}

async function submitMissing(state, referenceImage) {
  for (const model of qwenModels) {
    if (state.tasks[model]?.taskId) continue;
    console.log(`[live:${model}] submitting`);
    const submitted = await seedanceNz.submitImageTask(imageRequest(model, referenceImage), apiKey);
    state.tasks[model] = { kind: 'image', taskId: submitted.taskId, status: 'submitted' };
    saveState(state);
    console.log(`[live:${model}] accepted`);
  }
  for (const model of minimaxModels) {
    if (state.tasks[model]?.taskId) continue;
    console.log(`[live:${model}] submitting`);
    const submitted = await seedanceNz.submitHailuoTask(videoRequest(model, referenceImage), apiKey);
    state.tasks[model] = { kind: 'video', taskId: submitted.taskId, status: 'submitted' };
    saveState(state);
    console.log(`[live:${model}] accepted`);
  }
}

async function pollEntry(model, entry, state) {
  const deadline = Date.now() + 60 * 60 * 1000;
  let previous = '';
  while (Date.now() < deadline) {
    const result = entry.kind === 'image'
      ? await seedanceNz.queryImageTask(entry.taskId, apiKey)
      : await seedanceNz.queryTask(entry.taskId, apiKey);
    const line = `${result.status}:${result.progress || ''}`;
    if (line !== previous) console.log(`[live:${model}] ${line}`);
    previous = line;
    if (result.status === 'failed') {
      state.tasks[model].status = 'failed';
      state.tasks[model].failReason = result.failReason || 'unknown Provider error';
      saveState(state);
      throw new Error(`${model} failed: ${result.failReason || 'unknown Provider error'}`);
    }
    if (result.status === 'succeeded') {
      const urls = entry.kind === 'image' ? result.imageUrls : [result.videoUrl];
      const filtered = urls.filter(Boolean);
      if (filtered.length === 0) throw new Error(`${model} succeeded without a result URL`);
      state.tasks[model].status = 'succeeded';
      state.tasks[model].urls = filtered;
      saveState(state);
      return filtered;
    }
    await new Promise((resolve) => setTimeout(resolve, entry.kind === 'image' ? 4000 : 7000));
  }
  throw new Error(`${model} timed out`);
}

function imageExtension(format) {
  if (format === 'jpeg' || format === 'jpg') return 'jpg';
  if (format === 'webp') return 'webp';
  return 'png';
}

async function downloadAndValidate(model, kind, urls) {
  const outputs = [];
  for (let index = 0; index < urls.length; index += 1) {
    const response = await seedanceNz.fetchRemote(urls[index]);
    if (!response.ok) throw new Error(`${model} output download failed: HTTP ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length < 1024) throw new Error(`${model} output is unexpectedly small: ${buffer.length} bytes`);
    let extension;
    let media;
    if (kind === 'image') {
      const decoded = await sharp(buffer).metadata();
      if (!decoded.width || !decoded.height || !decoded.format) throw new Error(`${model} image decode failed`);
      media = {
        format: decoded.format,
        width: decoded.width,
        height: decoded.height,
        channels: decoded.channels || null,
        space: decoded.space || null,
      };
      extension = imageExtension(decoded.format);
    } else {
      extension = 'mp4';
    }
    const suffix = urls.length > 1 ? `-${index + 1}` : '';
    const file = path.join(outputDir, `${model}${suffix}.${extension}`);
    fs.writeFileSync(file, buffer);
    if (kind === 'video') {
      if (!fs.existsSync(ffprobe)) throw new Error('ffprobe runtime is missing');
      const probe = JSON.parse(run(ffprobe, [
        '-v', 'error', '-show_entries', 'format=format_name,duration,size', '-show_entries', 'stream=codec_name,width,height', '-of', 'json', file,
      ], `${model} ffprobe`));
      const stream = Array.isArray(probe.streams) ? probe.streams.find((item) => item.codec_name) : null;
      media = {
        format: probe.format?.format_name || null,
        duration: Number(probe.format?.duration || 0),
        codec: stream?.codec_name || null,
        width: Number(stream?.width || 0),
        height: Number(stream?.height || 0),
      };
      if (!media.duration || !media.codec || !media.width || !media.height) throw new Error(`${model} video decode failed`);
    }
    outputs.push({
      file: path.relative(root, file).replace(/\\/g, '/'),
      bytes: buffer.length,
      sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
      media,
    });
  }
  return outputs;
}

async function main() {
  const referenceImage = createReferenceImage();
  const state = loadState();
  applyExplicitRetry(state);
  await submitMissing(state, referenceImage);

  const results = [];
  for (const model of allModels) {
    const entry = state.tasks[model];
    if (!entry?.taskId) throw new Error(`${model} has no accepted task`);
    const urls = entry.status === 'succeeded' && Array.isArray(entry.urls) && entry.urls.length > 0
      ? entry.urls
      : await pollEntry(model, entry, state);
    const outputs = await downloadAndValidate(model, entry.kind, urls);
    results.push({
      model,
      kind: entry.kind,
      status: 'succeeded',
      attempts: 1 + (state.history?.[model]?.length || 0),
      outputs,
    });
    console.log(`[live:${model}] downloaded and decoded`);
  }

  const report = {
    ok: results.length === 11 && results.every((item) => item.status === 'succeeded'),
    verifiedAt: new Date().toISOString(),
    provider: 'seedance-nz',
    officialDocs: 'https://api.seedance.nz/docs/llms.txt',
    taskCount: results.length,
    credentialsPersisted: false,
    results,
  };
  fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`[live] verified ${results.length}/11 models; sanitized report: ${path.relative(root, reportFile)}`);
}

main().catch((error) => {
  console.error(`[live] ${error?.message || error}`);
  process.exitCode = 1;
});
