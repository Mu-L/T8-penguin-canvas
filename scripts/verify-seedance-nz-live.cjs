const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const seedanceNz = require('../backend/src/providers/seedanceNz');

const apiKey = String(process.env.SEEDANCE_NZ_API_KEY || '').trim();
if (!apiKey) {
  console.error('SEEDANCE_NZ_API_KEY is required');
  process.exit(2);
}

const root = path.resolve(__dirname, '..');
const ffmpeg = path.join(root, 'tools', 'ffmpeg-runtime', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 't8-seedance-nz-'));
const outputDir = path.join(root, 'output', `seedance-nz-live-${stamp}`);
fs.mkdirSync(outputDir, { recursive: true });

function runFfmpeg(args) {
  const result = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(`ffmpeg fixture creation failed: ${(result.stderr || result.stdout || '').trim().slice(0, 400)}`);
  }
}

function createFixtures() {
  if (!fs.existsSync(ffmpeg)) throw new Error(`ffmpeg runtime not found: ${ffmpeg}`);
  const image = path.join(tempDir, 'reference.png');
  const video = path.join(tempDir, 'reference.mp4');
  const audio = path.join(tempDir, 'reference.mp3');
  runFfmpeg(['-f', 'lavfi', '-i', 'color=c=0x2f7ed8:s=256x256:d=0.1', '-frames:v', '1', image]);
  runFfmpeg([
    '-f', 'lavfi', '-i', 'testsrc=size=256x256:rate=12',
    '-t', '5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', video,
  ]);
  runFfmpeg([
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=5',
    '-c:a', 'libmp3lame', '-b:a', '64k', audio,
  ]);
  return { image, video, audio };
}

function taskRequest(name, fixtures) {
  const common = {
    model: 'mini',
    duration: 4,
    ratio: '16:9',
    resolution: '480p',
    generate_audio: false,
    return_last_frame: false,
  };
  if (name === 't2v') {
    return {
      ...common,
      prompt: 'A small blue ceramic cup slowly rotates on a clean white table, fixed camera, no text.',
    };
  }
  if (name === 'i2v') {
    return {
      ...common,
      prompt: 'The blue reference image gently comes alive with a slow cinematic push-in, no text.',
      firstFrame: fixtures.image,
    };
  }
  return {
    ...common,
    prompt: 'Use @Image 1 as the color reference, follow the motion rhythm of @Video 1, and synchronize the pacing to @Audio 1. Keep the result abstract and free of text.',
    refImages: [fixtures.image],
    videos: [fixtures.video],
    audios: [fixtures.audio],
  };
}

async function pollTask(entry) {
  const startedAt = Date.now();
  const timeoutMs = 45 * 60 * 1000;
  let lastStatus = '';
  while (Date.now() - startedAt < timeoutMs) {
    const result = await seedanceNz.queryTask(entry.taskId, apiKey);
    const statusLine = `${result.status}:${result.progress || ''}`;
    if (statusLine !== lastStatus) {
      lastStatus = statusLine;
      console.log(`[live:${entry.name}] ${statusLine}`);
    }
    if (result.status === 'failed') throw new Error(`${entry.name} failed: ${result.failReason || 'unknown error'}`);
    if (result.status === 'succeeded') {
      if (!result.videoUrl) throw new Error(`${entry.name} completed without metadata.url`);
      return result.videoUrl;
    }
    await new Promise((resolve) => setTimeout(resolve, 4000));
  }
  throw new Error(`${entry.name} timed out after 45 minutes`);
}

async function downloadResult(name, url) {
  const response = await seedanceNz.fetchRemote(url);
  if (!response.ok) throw new Error(`${name} output download failed: HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length < 1024) throw new Error(`${name} output is unexpectedly small: ${buffer.length} bytes`);
  const file = path.join(outputDir, `${name}.mp4`);
  fs.writeFileSync(file, buffer);
  return {
    file,
    bytes: buffer.length,
    sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
  };
}

async function main() {
  const fixtures = createFixtures();
  const requestedCases = String(process.env.SEEDANCE_NZ_LIVE_CASES || 't2v,i2v,multi')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  const names = ['t2v', 'i2v', 'multi'].filter((name) => requestedCases.includes(name));
  const recovered = String(process.env.SEEDANCE_NZ_RECOVER_TASKS || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const separator = item.indexOf('=');
      const name = separator > 0 ? item.slice(0, separator).trim() : '';
      const taskId = separator > 0 ? item.slice(separator + 1).trim() : '';
      if (!['t2v', 'i2v', 'multi'].includes(name) || !taskId) return null;
      return { name, taskId, taskType: name, model: `seedance-2.0-mini-${name}` };
    })
    .filter(Boolean);
  if (names.length === 0 && recovered.length === 0) {
    throw new Error('SEEDANCE_NZ_LIVE_CASES or SEEDANCE_NZ_RECOVER_TASKS must select at least one task');
  }
  const submitted = [...recovered];
  for (const name of names) {
    console.log(`[live:${name}] submitting`);
    const result = await seedanceNz.submitTask(taskRequest(name, fixtures), apiKey);
    submitted.push({ name, ...result });
    console.log(`[live:${name}] submitted ${result.taskId} (${result.model})`);
  }

  const remoteUrls = await Promise.all(submitted.map(async (entry) => ({
    entry,
    url: await pollTask(entry),
  })));
  const outputs = [];
  for (const item of remoteUrls) {
    outputs.push({
      name: item.entry.name,
      taskId: item.entry.taskId,
      taskType: item.entry.taskType,
      model: item.entry.model,
      ...(await downloadResult(item.entry.name, item.url)),
    });
  }
  console.log(JSON.stringify({ ok: true, outputDir, outputs }, null, 2));
}

main().catch((error) => {
  console.error(`[live] ${error?.message || error}`);
  process.exitCode = 1;
});
