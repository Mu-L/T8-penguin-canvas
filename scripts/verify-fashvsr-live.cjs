'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const provider = require('../backend/src/providers/seedanceNz');
const { resolveBundledFfmpeg, resolveBundledFfprobe } = require('../backend/src/providers/llmMedia');

const root = path.resolve(__dirname, '..');
const evidenceDir = path.join(root, 'output', 'fashvsr-live-core-20260818');
const privateStatePath = path.join(root, '.tmp', 'fashvsr-live-core-private.json');
const inputPath = path.join(evidenceDir, 'input-854x480-3.2s.mp4');
const outputPath = path.join(evidenceDir, 'output-upscaled.mp4');
const reportPath = path.join(evidenceDir, 'report.json');
const apiKey = String(process.env.T8_FASHVSR_API_KEY || '').trim();

if (!apiKey.startsWith('sk-')) throw new Error('T8_FASHVSR_API_KEY is required');
fs.mkdirSync(evidenceDir, { recursive: true });
fs.mkdirSync(path.dirname(privateStatePath), { recursive: true });

function probe(filePath) {
  return JSON.parse(execFileSync(resolveBundledFfprobe(), [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=codec_name,width,height,duration:format=duration,format_name',
    '-of', 'json',
    filePath,
  ], { encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024 }));
}

function summarizeProbe(value) {
  const stream = Array.isArray(value?.streams) ? value.streams[0] : {};
  return {
    codec: String(stream?.codec_name || ''),
    width: Number(stream?.width),
    height: Number(stream?.height),
    durationSeconds: Number(value?.format?.duration || stream?.duration),
    format: String(value?.format?.format_name || ''),
  };
}

function ensureInput() {
  if (fs.existsSync(inputPath)) return;
  execFileSync(resolveBundledFfmpeg(), [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=854x480:rate=24',
    '-t', '3.2', '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart', inputPath,
  ], { windowsHide: true, stdio: 'inherit' });
}

function readState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(privateStatePath, 'utf8'));
    return typeof parsed?.taskId === 'string' && parsed.taskId ? parsed : null;
  } catch {
    return null;
  }
}

function saveState(value) {
  fs.writeFileSync(privateStatePath, JSON.stringify(value), { encoding: 'utf8', mode: 0o600 });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function download(url) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`result download failed with HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length < 1024) throw new Error('result download is unexpectedly small');
  fs.writeFileSync(outputPath, bytes);
  return bytes;
}

async function main() {
  ensureInput();
  const inputProbe = summarizeProbe(probe(inputPath));
  if (inputProbe.height !== 480 || inputProbe.durationSeconds < 3 || inputProbe.durationSeconds > 15) {
    throw new Error('generated input does not satisfy FashVSR contract');
  }

  let state = readState();
  let submittedThisRun = false;
  if (!state) {
    const result = await provider.submitFashVsrTask({
      model: provider.FASHVSR_VIDEO_UPSCALE_MODEL,
      videos: [inputPath],
    }, apiKey, {
      uploadIntervalMs: 0,
      ffprobePath: resolveBundledFfprobe(),
    });
    state = { taskId: result.taskId, submittedAt: new Date().toISOString() };
    saveState(state);
    submittedThisRun = true;
  }

  let completed;
  const startedAt = Date.now();
  while (Date.now() - startedAt < 30 * 60 * 1000) {
    const result = await provider.queryFashVsrTask(state.taskId, apiKey);
    if (result.status === 'failed') throw new Error(result.failReason || 'FashVSR task failed');
    if (result.status === 'succeeded') {
      if (!result.videoUrl) throw new Error('FashVSR completed without video URL');
      completed = result;
      break;
    }
    await sleep(5000);
  }
  if (!completed) throw new Error('FashVSR live verification timed out');

  const bytes = await download(completed.videoUrl);
  const outputProbe = summarizeProbe(probe(outputPath));
  execFileSync(resolveBundledFfmpeg(), [
    '-hide_banner', '-loglevel', 'error', '-i', outputPath, '-f', 'null', '-',
  ], { windowsHide: true, stdio: 'inherit' });
  const report = {
    schema: 't8-fashvsr-live-verification-v1',
    verifiedAt: new Date().toISOString(),
    coreDirectory: root,
    provider: 'zhenzhen-budget-house',
    model: provider.FASHVSR_VIDEO_UPSCALE_MODEL,
    submitEndpoint: '/v1/video/generations',
    queryEndpoint: '/v1/video/generations/{task_id}',
    submittedThisRun,
    completed: true,
    downloaded: true,
    fullDecodePassed: true,
    input: {
      file: path.basename(inputPath),
      bytes: fs.statSync(inputPath).size,
      sha256: crypto.createHash('sha256').update(fs.readFileSync(inputPath)).digest('hex'),
      ...inputProbe,
    },
    output: {
      file: path.basename(outputPath),
      bytes: bytes.length,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      ...outputProbe,
    },
    secretFree: true,
  };
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  fs.rmSync(privateStatePath, { force: true });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error?.message || error);
  process.exitCode = 1;
});
