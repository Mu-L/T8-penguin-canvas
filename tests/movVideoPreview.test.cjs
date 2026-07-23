const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const filesRouter = require('../backend/src/routes/files');
const { resolveBundledFfprobe } = require('../backend/src/providers/llmMedia');

function run(binary, args, label) {
  const result = spawnSync(binary, args, { encoding: 'utf8', windowsHide: true });
  assert.equal(
    result.status,
    0,
    `${label} failed (${result.status}): ${String(result.stderr || result.stdout || '').slice(-2000)}`,
  );
  return result;
}

test('real ProRes MOV is converted to browser-compatible H.264/AAC MP4 preview', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-mov-preview-'));
  const source = path.join(directory, 'source.mov');
  const target = path.join(directory, 'preview.mp4');
  const ffmpeg = require('ffmpeg-static');
  try {
    run(ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc2=size=64x96:rate=12:duration=0.5',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.5',
      '-c:v', 'prores_ks', '-profile:v', '3', '-pix_fmt', 'yuv444p10le',
      '-c:a', 'pcm_s16le', '-shortest', '-threads', '1',
      source,
    ], 'create ProRes MOV');

    await filesRouter._test.runCompatibleVideoPreviewFfmpeg(source, target, {
      ffmpegPath: ffmpeg,
      timeoutMs: 60_000,
    });

    const probe = run(resolveBundledFfprobe(), [
      '-v', 'error',
      '-show_entries', 'stream=codec_name,codec_type,pix_fmt',
      '-show_entries', 'format=format_name,duration,size',
      '-of', 'json',
      target,
    ], 'probe compatible preview');
    const parsed = JSON.parse(probe.stdout);
    const video = parsed.streams.find((stream) => stream.codec_type === 'video');
    const audio = parsed.streams.find((stream) => stream.codec_type === 'audio');
    assert.equal(video.codec_name, 'h264');
    assert.equal(video.pix_fmt, 'yuv420p');
    assert.equal(audio.codec_name, 'aac');
    assert.ok(Number(parsed.format.duration) > 0);
    assert.ok(Number(parsed.format.size) > 1024);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
