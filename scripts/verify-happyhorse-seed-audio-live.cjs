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
const ffprobe = path.join(root, 'tools', 'ffmpeg-runtime', process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 't8-happyhorse-audio-'));
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outputDir = path.join(root, 'output', `happyhorse-seed-audio-live-${stamp}`);
fs.mkdirSync(outputDir, { recursive: true });

function run(command, args, label) {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) {
    throw new Error(`${label} failed: ${(result.stderr || result.stdout || '').trim().slice(0, 500)}`);
  }
  return result.stdout;
}

function createImages() {
  const first = path.join(tempDir, 'reference-1.png');
  const second = path.join(tempDir, 'reference-2.png');
  run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x2878c8:s=512x512:d=0.1', '-vf', 'drawbox=x=136:y=136:w=240:h=240:color=white:t=fill', '-frames:v', '1', first], 'fixture 1');
  run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0xe8a43a:s=512x512:d=0.1', '-vf', 'drawbox=x=96:y=176:w=320:h=160:color=0x24324a:t=fill', '-frames:v', '1', second], 'fixture 2');
  return { first, second };
}

async function pollVideo(entry) {
  const deadline = Date.now() + 45 * 60 * 1000;
  let previous = '';
  while (Date.now() < deadline) {
    const result = await seedanceNz.queryTask(entry.taskId, apiKey);
    const line = `${result.status}:${result.progress || ''}`;
    if (line !== previous) console.log(`[live:${entry.name}] ${line}`);
    previous = line;
    if (result.status === 'failed') throw new Error(`${entry.name} failed: ${result.failReason || 'unknown error'}`);
    if (result.status === 'succeeded') {
      if (!result.videoUrl) throw new Error(`${entry.name} succeeded without video URL`);
      return result.videoUrl;
    }
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  throw new Error(`${entry.name} timed out`);
}

async function pollAudio(taskId) {
  const deadline = Date.now() + 30 * 60 * 1000;
  let previous = '';
  while (Date.now() < deadline) {
    const result = await seedanceNz.queryAudioTask(taskId, apiKey);
    const line = `${result.status}:${result.progress || ''}`;
    if (line !== previous) console.log(`[live:seed-audio] ${line}`);
    previous = line;
    if (result.status === 'failed') throw new Error(`seed-audio failed: ${result.failReason || 'unknown error'}`);
    if (result.status === 'succeeded') {
      if (!result.audioUrl) throw new Error('seed-audio succeeded without audio URL');
      return result.audioUrl;
    }
    await new Promise((resolve) => setTimeout(resolve, 4000));
  }
  throw new Error('seed-audio timed out');
}

async function download(name, url, extension) {
  const response = await seedanceNz.fetchRemote(url);
  if (!response.ok) throw new Error(`${name} download failed: HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length < 1024) throw new Error(`${name} output too small: ${buffer.length}`);
  const file = path.join(outputDir, `${name}.${extension}`);
  fs.writeFileSync(file, buffer);
  const probe = JSON.parse(run(ffprobe, ['-v', 'error', '-show_entries', 'format=format_name,duration,size', '-of', 'json', file], `${name} ffprobe`));
  return {
    file,
    bytes: buffer.length,
    sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
    format: probe.format,
  };
}

async function main() {
  if (!fs.existsSync(ffmpeg) || !fs.existsSync(ffprobe)) throw new Error('ffmpeg/ffprobe runtime is missing');
  const images = createImages();
  const requests = [
    {
      name: 'happyhorse-t2v',
      request: {
        model: 'happyhorse-1.1-t2v',
        prompt: 'A simple white paper horse trots across a clean blue studio floor, fixed camera, no text.',
        duration: 3, resolution: '720p', ratio: '1:1',
      },
    },
    {
      name: 'happyhorse-i2v',
      request: {
        model: 'happyhorse-1.1-i2v',
        prompt: 'The geometric shape gently rotates, fixed camera, no text.',
        duration: 3, resolution: '720p', ratio: '1:1', images: [images.first],
      },
    },
    {
      name: 'happyhorse-r2v',
      request: {
        model: 'happyhorse-1.1-r2v',
        prompt: 'Use 图1 as the opening composition and 图2 as the color and shape reference, smooth transition, no text.',
        duration: 3, resolution: '720p', ratio: '1:1', images: [images.first, images.second],
      },
    },
  ];

  const videoEntries = [];
  for (const item of requests) {
    console.log(`[live:${item.name}] submitting`);
    const submitted = await seedanceNz.submitHappyHorseTask(item.request, apiKey);
    videoEntries.push({ name: item.name, ...submitted });
    console.log(`[live:${item.name}] submitted ${submitted.taskId}`);
  }
  console.log('[live:seed-audio] submitting');
  const audioEntry = await seedanceNz.submitAudioTask({
    model: 'doubao-seed-audio-1.0',
    prompt: 'A short clean notification chime with two warm glass notes, no voice, quiet fade out.',
    outputFormat: 'mp3', sampleRate: '24000', speechRate: 0, loudnessRate: 0, pitchRate: 0,
  }, apiKey);
  console.log(`[live:seed-audio] submitted ${audioEntry.taskId}`);

  const videoUrls = await Promise.all(videoEntries.map(async (entry) => ({ entry, url: await pollVideo(entry) })));
  const audioUrl = await pollAudio(audioEntry.taskId);
  const outputs = [];
  for (const item of videoUrls) outputs.push({ name: item.entry.name, taskId: item.entry.taskId, ...(await download(item.entry.name, item.url, 'mp4')) });
  outputs.push({ name: 'seed-audio', taskId: audioEntry.taskId, ...(await download('seed-audio', audioUrl, 'mp3')) });
  console.log(JSON.stringify({ ok: true, outputDir, outputs }, null, 2));
}

main().catch((error) => {
  console.error(`[live] ${error?.message || error}`);
  process.exitCode = 1;
});
