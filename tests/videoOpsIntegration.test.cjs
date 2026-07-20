const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const express = require('express');
const config = require('../backend/src/config');
const videoOpsRouter = require('../backend/src/routes/videoOps');
const { resolveBundledFfmpeg, resolveBundledFfprobe } = require('../backend/src/providers/llmMedia');

function runFfmpeg(args) {
  const ffmpeg = resolveBundledFfmpeg();
  const result = spawnSync(ffmpeg, args, { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ffmpegInfo(file) {
  const ffmpeg = resolveBundledFfmpeg();
  return spawnSync(ffmpeg, ['-hide_banner', '-i', file], { encoding: 'utf8' }).stderr || '';
}

function maxGrayPixelAt(file, at = 0.4) {
  const ffmpeg = resolveBundledFfmpeg();
  const result = spawnSync(ffmpeg, [
    '-hide_banner',
    '-loglevel', 'error',
    '-ss', String(at),
    '-i', file,
    '-frames:v', '1',
    '-vf', 'format=gray',
    '-f', 'rawvideo',
    'pipe:1',
  ], { encoding: 'buffer', maxBuffer: 10 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr?.toString() || result.stdout?.toString());
  return Array.from(result.stdout).reduce((max, value) => Math.max(max, value), 0);
}

function rgbPixelAt(file, at = 0.4) {
  const ffmpeg = resolveBundledFfmpeg();
  const result = spawnSync(ffmpeg, [
    '-hide_banner',
    '-loglevel', 'error',
    '-ss', String(at),
    '-i', file,
    '-frames:v', '1',
    '-vf', 'scale=1:1,format=rgb24',
    '-f', 'rawvideo',
    'pipe:1',
  ], { encoding: 'buffer', maxBuffer: 10 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr?.toString() || result.stdout?.toString());
  assert.ok(result.stdout.length >= 3, 'expected one RGB pixel from ffmpeg');
  return { r: result.stdout[0], g: result.stdout[1], b: result.stdout[2] };
}

function rgbPixelAtPoint(file, x, y, at = 0.4) {
  const ffmpeg = resolveBundledFfmpeg();
  const result = spawnSync(ffmpeg, [
    '-hide_banner',
    '-loglevel', 'error',
    '-ss', String(at),
    '-i', file,
    '-frames:v', '1',
    '-vf', `crop=1:1:${Math.max(0, Math.round(x))}:${Math.max(0, Math.round(y))},format=rgb24`,
    '-f', 'rawvideo',
    'pipe:1',
  ], { encoding: 'buffer', maxBuffer: 10 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr?.toString() || result.stdout?.toString());
  assert.ok(result.stdout.length >= 3, 'expected one RGB pixel from ffmpeg');
  return { r: result.stdout[0], g: result.stdout[1], b: result.stdout[2] };
}

function audioRmsAt(file, at = 0.4, duration = 0.12) {
  const ffmpeg = resolveBundledFfmpeg();
  const result = spawnSync(ffmpeg, [
    '-hide_banner',
    '-loglevel', 'error',
    '-ss', String(at),
    '-t', String(duration),
    '-i', file,
    '-vn',
    '-ac', '1',
    '-ar', '8000',
    '-f', 'f32le',
    'pipe:1',
  ], { encoding: 'buffer', maxBuffer: 10 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr?.toString() || result.stdout?.toString());
  const sampleCount = Math.floor(result.stdout.length / 4);
  assert.ok(sampleCount > 0, 'expected audio samples from ffmpeg');
  let sum = 0;
  for (let offset = 0; offset + 4 <= result.stdout.length; offset += 4) {
    const sample = result.stdout.readFloatLE(offset);
    sum += sample * sample;
  }
  return Math.sqrt(sum / sampleCount);
}

function listenVideoOps() {
  const app = express();
  app.use(express.json({ limit: '20mb' }));
  app.use('/api/video-ops', videoOpsRouter);
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${address.port}` });
    });
  });
}

test('videoOps keeps linked source audio in-band and mixes only independent timeline audio', () => {
  const routeSource = fs.readFileSync(path.join(__dirname, '..', 'backend', 'src', 'routes', 'videoOps.js'), 'utf8');
  assert.match(routeSource, /const linkedSourceAudioEnvelopes = sourceAudioEnvelopeByVideoItemId\(options\?\.renderPlan, settings\);/);
  assert.match(routeSource, /audioEnvelope: linkedSourceAudioEnvelopes\.get\(sources\[i\]\.clip\?\.sourceItemId\) \|\| null,/);
  assert.match(routeSource, /const keepAudio = !forceMuteAudio && shouldKeepAudio\(settings, clip, index, probe\);/);
  assert.match(routeSource, /const audioSegments = independentTimelineAudioSegments\(renderPlan, settings\);/);
  assert.match(routeSource, /\[0:a:0\]apad=whole_dur=\$\{targetDuration\.toFixed\(3\)\}/);
  assert.match(routeSource, /mixLabels\.push\('baseaud'\);/);
  assert.doesNotMatch(routeSource, /forceRenderPlanAudioMix/);
});

test('videoOps builds audio fades and volume curves for timeline render plan audio', () => {
  assert.equal(typeof videoOpsRouter._test.normalizeTimelineAudioSegments, 'function');
  assert.equal(typeof videoOpsRouter._test.buildTimelineAudioEnvelopeFilters, 'function');
  assert.deepEqual(videoOpsRouter._test.buildTimelineAudioEnvelopeFilters({
    duration: 2,
    volume: 0.8,
    audioFadeIn: 0.5,
    audioFadeOut: 0.75,
    volumeCurve: 'linear-down',
  }), [
    'volume=0.800',
    'afade=t=out:st=0:d=2.000',
    'afade=t=in:st=0:d=0.500',
    'afade=t=out:st=1.250:d=0.750',
  ]);
  assert.deepEqual(videoOpsRouter._test.buildTimelineAudioEnvelopeFilters({
    duration: 5,
    volume: 1,
    volumeCurve: 'duck',
  }), [
    'volume=1.000',
    'volume=0.550',
  ]);

  const segments = videoOpsRouter._test.normalizeTimelineAudioSegments({
    audio: [{
      url: '/files/input/bgm.m4a',
      timelineStart: 0,
      timelineEnd: 3,
      trimStart: 0,
      trimEnd: 3,
      volume: 1.2,
      muted: false,
      audioFadeIn: 9,
      audioFadeOut: 1,
      volumeCurve: 'duck',
    }],
  }, { audio: 'keep' });
  assert.equal(segments.length, 1);
  assert.equal(segments[0].audioFadeIn, 3);
  assert.equal(segments[0].audioFadeOut, 1);
  assert.equal(segments[0].volumeCurve, 'duck');
});

test('videoOps converts timeline text segments into bounded subtitle drawtext filters', () => {
  assert.equal(typeof videoOpsRouter._test.buildSubtitleDrawtextFilters, 'function');
  assert.equal(typeof videoOpsRouter._test.wrapSubtitleDrawtextText, 'function');

  const filters = videoOpsRouter._test.buildSubtitleDrawtextFilters([
    {
      id: 'text-1',
      text: "第一句字幕: 'T8'",
      timelineStart: 0.5,
      timelineEnd: 2.5,
      position: 'bottom',
      color: '#ffffff',
      fontSize: 42,
      background: 'rgba(0,0,0,0.45)',
    },
  ], { width: 1280, height: 720 });

  assert.equal(filters.length, 1);
  assert.match(filters[0], /^drawtext=/);
  assert.match(filters[0], /enable='between\(t,0\.500,2\.500\)'/);
  assert.match(filters[0], /x=\(w-tw\)\/2/);
  assert.match(filters[0], /y=h-th-58/);
  assert.doesNotMatch(filters[0], /undefined|null/);
  assert.doesNotMatch(filters[0], /第一句字幕: 'T8'/);

  const wrapped = videoOpsRouter._test.wrapSubtitleDrawtextText(
    '这是一句非常非常长的字幕，应该自动换行后再烧录到视频里，否则在竖屏或小尺寸素材上会直接被裁掉',
    { width: 320, height: 180 },
    34,
  );
  assert.match(wrapped, /\n/);
  const wrappedFilters = videoOpsRouter._test.buildSubtitleDrawtextFilters([
    {
      id: 'text-long',
      text: wrapped,
      timelineStart: 0,
      timelineEnd: 1,
      fontSize: 34,
    },
  ], { width: 320, height: 180 });
  assert.match(wrappedFilters[0], /\\n/);
});

test('videoOps burns timeline text render plan into composed video pixels', async () => {
  fs.mkdirSync(config.INPUT_DIR, { recursive: true });
  fs.mkdirSync(config.OUTPUT_DIR, { recursive: true });

  const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const clip = path.join(config.INPUT_DIR, `video_edit_subtitle_${stamp}.mp4`);
  runFfmpeg([
    '-y',
    '-f', 'lavfi', '-i', 'color=c=black:s=320x180:r=24:d=1.1',
    '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
    '-shortest',
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    clip,
  ]);

  let outputFile = '';
  try {
    const renderPlan = {
      version: 1,
      duration: 1.1,
      tracks: [{ id: 'track-text-subtitle', kind: 'text', name: '字幕轨', order: 2 }],
      clips: [
        {
          id: 'render-clip-subtitle-test',
          sourceItemId: 'item-video-1',
          assetId: 'asset-video-1',
          trackId: 'track-video-main',
          kind: 'video',
          timelineStart: 0,
          timelineEnd: 1.1,
          trimStart: 0,
          trimEnd: 1.1,
          muted: false,
          name: 'black.mp4',
          url: `/files/input/${path.basename(clip)}`,
        },
      ],
      audio: [],
      text: [
        {
          id: 'render-subtitle-1',
          sourceItemId: 'item-subtitle-1',
          assetId: 'asset-subtitle-1',
          trackId: 'track-text-subtitle',
          kind: 'text',
          timelineStart: 0.2,
          timelineEnd: 0.9,
          text: 'T8 subtitle burn 100%',
          name: '字幕 1',
          position: 'bottom',
          color: '#ffffff',
          fontSize: 34,
          background: 'rgba(0,0,0,0.65)',
        },
      ],
      warnings: [],
    };

    const result = await videoOpsRouter._test.composeVideoEdit(
      renderPlan.clips,
      {
        aspect: '16:9',
        resolution: 'first',
        transition: 'none',
        transitionDuration: 0.3,
        filter: 'none',
        audio: 'keep',
      },
      undefined,
      { renderPlan },
    );

    outputFile = path.join(config.OUTPUT_DIR, path.basename(result.videoUrl));
    assert.equal(result.subtitleBurnedIn, true);
    assert.equal(result.subtitleCount, 1);
    assert.ok(maxGrayPixelAt(outputFile, 0.45) > 80, 'subtitle frame should contain bright text pixels');
  } finally {
    for (const file of [clip, outputFile]) {
      if (file) {
        try { fs.unlinkSync(file); } catch (_) {}
      }
    }
  }
});

test('videoOps mixes independent timeline audio render plan into composed video output', async () => {
  fs.mkdirSync(config.INPUT_DIR, { recursive: true });
  fs.mkdirSync(config.OUTPUT_DIR, { recursive: true });

  const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const clip = path.join(config.INPUT_DIR, `video_edit_multitrack_video_${stamp}.mp4`);
  const audio = path.join(config.INPUT_DIR, `video_edit_multitrack_audio_${stamp}.m4a`);

  runFfmpeg([
    '-y',
    '-f', 'lavfi', '-i', 'color=c=black:s=320x180:r=24:d=1.2',
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    clip,
  ]);
  runFfmpeg([
    '-y',
    '-f', 'lavfi', '-i', 'sine=frequency=880:duration=0.7',
    '-c:a', 'aac',
    audio,
  ]);

  let outputFile = '';
  try {
    const renderPlan = {
      version: 1,
      duration: 1.2,
      tracks: [
        { id: 'track-video-main', kind: 'video', name: '视频轨', order: 0 },
        { id: 'track-audio-bgm', kind: 'audio', name: '音频轨', order: 1 },
      ],
      clips: [
        {
          id: 'render-clip-no-audio',
          sourceItemId: 'item-video-1',
          assetId: 'asset-video-1',
          trackId: 'track-video-main',
          kind: 'video',
          timelineStart: 0,
          timelineEnd: 1.2,
          trimStart: 0,
          trimEnd: 1.2,
          muted: true,
          name: 'silent.mp4',
          url: `/files/input/${path.basename(clip)}`,
        },
      ],
      audio: [
        {
          id: 'render-audio-bgm',
          sourceItemId: 'item-audio-1',
          assetId: 'asset-audio-1',
          trackId: 'track-audio-bgm',
          kind: 'audio',
          trackOrder: 1,
          timelineStart: 0.25,
          timelineEnd: 0.95,
          trimStart: 0,
          trimEnd: 0.7,
          muted: false,
          volume: 0.8,
          name: 'tone.m4a',
          url: `/files/input/${path.basename(audio)}`,
        },
      ],
      text: [],
      warnings: [],
    };

    const result = await videoOpsRouter._test.composeVideoEdit(
      renderPlan.clips,
      {
        aspect: '16:9',
        resolution: 'first',
        transition: 'none',
        transitionDuration: 0.3,
        filter: 'none',
        audio: 'keep',
      },
      undefined,
      { renderPlan },
    );

    outputFile = path.join(config.OUTPUT_DIR, path.basename(result.videoUrl));
    assert.equal(result.timelineAudioMixed, true);
    assert.equal(result.timelineAudioCount, 1);
    const probe = await videoOpsRouter._test.probeFile(outputFile, null);
    assert.equal(probe.hasAudio, true);
    assert.ok(probe.duration >= 1.1 && probe.duration <= 1.4, `expected video duration around 1.2s, got ${probe.duration}`);
  } finally {
    for (const file of [clip, audio, outputFile]) {
      if (file) {
        try { fs.unlinkSync(file); } catch (_) {}
      }
    }
  }
});

test('videoOps composes real clips through bundled ffmpeg even when audio tracks differ', async () => {
  fs.mkdirSync(config.INPUT_DIR, { recursive: true });
  fs.mkdirSync(config.OUTPUT_DIR, { recursive: true });

  const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const clipA = path.join(config.INPUT_DIR, `video_edit_test_a_${stamp}.mp4`);
  const clipB = path.join(config.INPUT_DIR, `video_edit_test_b_${stamp}.mp4`);

  runFfmpeg([
    '-y',
    '-f', 'lavfi', '-i', 'color=c=red:s=160x90:r=12:d=0.6',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.6',
    '-shortest',
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    clipA,
  ]);
  runFfmpeg([
    '-y',
    '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=12:d=0.6',
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    clipB,
  ]);

  try {
    const result = await videoOpsRouter._test.composeVideoEdit(
      [
        { url: `/files/input/${path.basename(clipA)}`, trimStart: 0 },
        { url: `/files/input/${path.basename(clipB)}`, trimStart: 0 },
      ],
      {
        aspect: '16:9',
        resolution: 'first',
        transition: 'black',
        transitionDuration: 0.1,
        filter: 'warm',
        audio: 'keep',
      },
    );

    assert.match(result.videoUrl, /^\/files\/output\/video_edit_/);
    assert.equal(result.mime, 'video/mp4');
    assert.ok(result.size > 1000);
    assert.ok(result.duration >= 1);
    assert.equal(result.width, 160);
    assert.equal(result.height, 90);
    const outputFile = path.join(config.OUTPUT_DIR, path.basename(result.videoUrl));
    assert.ok(fs.existsSync(outputFile));
    try { fs.unlinkSync(outputFile); } catch (_) {}
  } finally {
    for (const file of [clipA, clipB]) {
      try { fs.unlinkSync(file); } catch (_) {}
    }
  }
});

test('videoOps respects multitrack video layer timing when renderPlan has overlays', async () => {
  fs.mkdirSync(config.INPUT_DIR, { recursive: true });
  fs.mkdirSync(config.OUTPUT_DIR, { recursive: true });

  const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const baseClip = path.join(config.INPUT_DIR, `video_edit_layer_base_${stamp}.mp4`);
  const overlayClip = path.join(config.INPUT_DIR, `video_edit_layer_overlay_${stamp}.mp4`);

  runFfmpeg([
    '-y',
    '-f', 'lavfi', '-i', 'color=c=red:s=160x90:r=24:d=2',
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    baseClip,
  ]);
  runFfmpeg([
    '-y',
    '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=24:d=1',
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    overlayClip,
  ]);

  let outputFile = '';
  try {
    const renderPlan = {
      version: 1,
      duration: 2,
      tracks: [
        { id: 'track-base', kind: 'video', order: 0 },
        { id: 'track-overlay', kind: 'video', order: 1 },
      ],
      clips: [
        {
          id: 'base-render',
          sourceItemId: 'base',
          trackId: 'track-base',
          layerIndex: 0,
          trackOrder: 0,
          timelineStart: 0,
          timelineEnd: 2,
          trimStart: 0,
          trimEnd: 2,
          url: `/files/input/${path.basename(baseClip)}`,
          directUrl: `/files/input/${path.basename(baseClip)}`,
          name: 'red base',
        },
        {
          id: 'overlay-render',
          sourceItemId: 'overlay',
          trackId: 'track-overlay',
          layerIndex: 1,
          trackOrder: 1,
          timelineStart: 0.5,
          timelineEnd: 1.5,
          trimStart: 0,
          trimEnd: 1,
          url: `/files/input/${path.basename(overlayClip)}`,
          directUrl: `/files/input/${path.basename(overlayClip)}`,
          name: 'blue overlay',
          x: 50,
          y: 50,
          scale: 0.5,
          opacity: 1,
        },
      ],
      audio: [],
      text: [],
      warnings: [],
    };

    const result = await videoOpsRouter._test.composeVideoEdit(
      renderPlan.clips,
      {
        aspect: '16:9',
        resolution: 'first',
        transition: 'none',
        filter: 'none',
        audio: 'mute',
      },
      undefined,
      { renderPlan },
    );

    assert.equal(result.timelineVideoComposited, true);
    assert.equal(result.timelineVideoLayerCount, 2);
    assert.equal(result.timelineVideoPipCount, 1);
    outputFile = path.join(config.OUTPUT_DIR, path.basename(result.videoUrl));
    const probe = await videoOpsRouter._test.probeFile(outputFile, null);
    assert.ok(probe.duration >= 1.85 && probe.duration <= 2.15, `expected timeline duration around 2s, got ${probe.duration}`);

    const early = rgbPixelAt(outputFile, 0.25);
    const late = rgbPixelAt(outputFile, 1.75);
    const middleCenter = rgbPixelAtPoint(outputFile, 80, 45, 0.75);
    const middleCorner = rgbPixelAtPoint(outputFile, 10, 10, 0.75);

    assert.ok(early.r > 170 && early.b < 100, `expected red base before overlay, got ${JSON.stringify(early)}`);
    assert.ok(middleCenter.b > 150 && middleCenter.r < 120, `expected blue pip at center, got ${JSON.stringify(middleCenter)}`);
    assert.ok(middleCorner.r > 170 && middleCorner.b < 100, `expected red base outside pip, got ${JSON.stringify(middleCorner)}`);
    assert.ok(late.r > 170 && late.b < 100, `expected red base after overlay, got ${JSON.stringify(late)}`);
  } finally {
    for (const file of [baseClip, overlayClip, outputFile]) {
      if (file) {
        try { fs.unlinkSync(file); } catch (_) {}
      }
    }
  }
});

test('videoOps keeps portrait pip overlays from covering the base with padded black bars', async () => {
  fs.mkdirSync(config.INPUT_DIR, { recursive: true });
  fs.mkdirSync(config.OUTPUT_DIR, { recursive: true });

  const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const baseClip = path.join(config.INPUT_DIR, `video_edit_pip_base_${stamp}.mp4`);
  const portraitClip = path.join(config.INPUT_DIR, `video_edit_pip_portrait_${stamp}.mp4`);

  runFfmpeg([
    '-y',
    '-f', 'lavfi', '-i', 'color=c=red:s=160x90:r=24:d=1',
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    baseClip,
  ]);
  runFfmpeg([
    '-y',
    '-f', 'lavfi', '-i', 'color=c=green:s=60x120:r=24:d=1',
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    portraitClip,
  ]);

  let outputFile = '';
  try {
    const renderPlan = {
      version: 1,
      duration: 1,
      tracks: [
        { id: 'track-base', kind: 'video', order: 0 },
        { id: 'track-pip', kind: 'video', order: 1 },
      ],
      clips: [
        {
          id: 'base-render',
          sourceItemId: 'base',
          trackId: 'track-base',
          layerIndex: 0,
          trackOrder: 0,
          timelineStart: 0,
          timelineEnd: 1,
          trimStart: 0,
          trimEnd: 1,
          url: `/files/input/${path.basename(baseClip)}`,
          directUrl: `/files/input/${path.basename(baseClip)}`,
          name: 'red base',
        },
        {
          id: 'pip-render',
          sourceItemId: 'pip',
          trackId: 'track-pip',
          layerIndex: 1,
          trackOrder: 1,
          timelineStart: 0,
          timelineEnd: 1,
          trimStart: 0,
          trimEnd: 1,
          url: `/files/input/${path.basename(portraitClip)}`,
          directUrl: `/files/input/${path.basename(portraitClip)}`,
          name: 'portrait green pip',
          width: 60,
          height: 120,
          x: 50,
          y: 50,
          scale: 0.4,
          opacity: 1,
        },
      ],
      audio: [],
      text: [],
      warnings: [],
    };

    const result = await videoOpsRouter._test.composeVideoEdit(
      renderPlan.clips,
      {
        aspect: '16:9',
        resolution: 'first',
        transition: 'none',
        filter: 'none',
        audio: 'mute',
      },
      undefined,
      { renderPlan },
    );

    outputFile = path.join(config.OUTPUT_DIR, path.basename(result.videoUrl));
    const center = rgbPixelAtPoint(outputFile, 80, 45, 0.5);
    const outsidePipInsideOldPaddedBox = rgbPixelAtPoint(outputFile, 60, 45, 0.5);

    assert.ok(center.g > 90 && center.r < 100 && center.b < 100, `expected green portrait pip center, got ${JSON.stringify(center)}`);
    assert.ok(
      outsidePipInsideOldPaddedBox.r > 150 && outsidePipInsideOldPaddedBox.b < 100,
      `expected red base to remain outside portrait content, got ${JSON.stringify(outsidePipInsideOldPaddedBox)}`,
    );
  } finally {
    for (const file of [baseClip, portraitClip, outputFile]) {
      if (file) {
        try { fs.unlinkSync(file); } catch (_) {}
      }
    }
  }
});

test('videoOps rejects unsupported render plan capabilities before composing', async () => {
  await assert.rejects(
    () => videoOpsRouter._test.composeVideoEdit(
      [{ url: '/files/input/never_resolved.mp4' }],
      {
        aspect: '16:9',
        resolution: 'first',
        transition: 'none',
        filter: 'none',
        audio: 'mute',
      },
      undefined,
      {
        renderPlan: {
          version: 1,
          duration: 1,
          tracks: [],
          clips: [],
          audio: [],
          text: [],
          unsupported: ['画中画位移'],
          warnings: [],
        },
      },
    ),
    /暂不支持.*画中画位移/,
  );
});

test('videoOps composes timeline layers with native xfade on the primary track', async () => {
  fs.mkdirSync(config.INPUT_DIR, { recursive: true });
  fs.mkdirSync(config.OUTPUT_DIR, { recursive: true });

  const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const redClip = path.join(config.INPUT_DIR, `video_edit_timeline_xfade_red_${stamp}.mp4`);
  const blueClip = path.join(config.INPUT_DIR, `video_edit_timeline_xfade_blue_${stamp}.mp4`);
  const overlayClip = path.join(config.INPUT_DIR, `video_edit_timeline_xfade_overlay_${stamp}.mp4`);

  runFfmpeg([
    '-y',
    '-f', 'lavfi', '-i', 'color=c=red:s=160x90:r=30:d=1.0',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1.0',
    '-shortest',
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    redClip,
  ]);
  runFfmpeg([
    '-y',
    '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=30:d=1.0',
    '-f', 'lavfi', '-i', 'sine=frequency=660:duration=1.0',
    '-shortest',
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    blueClip,
  ]);
  runFfmpeg([
    '-y',
    '-f', 'lavfi', '-i', 'color=c=green:s=64x64:r=30:d=0.8',
    '-f', 'lavfi', '-i', 'sine=frequency=880:duration=0.8',
    '-shortest',
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    overlayClip,
  ]);

  const clips = [
    {
      id: 'base-red',
      url: `/files/input/${path.basename(redClip)}`,
      trimStart: 0,
      trimEnd: 1,
      layerIndex: 0,
      trackOrder: 0,
      timelineStart: 0,
      timelineEnd: 1,
      x: 0,
      y: 0,
      scale: 1,
      opacity: 1,
    },
    {
      id: 'base-blue',
      url: `/files/input/${path.basename(blueClip)}`,
      trimStart: 0,
      trimEnd: 1,
      layerIndex: 0,
      trackOrder: 0,
      timelineStart: 1,
      timelineEnd: 2,
      x: 0,
      y: 0,
      scale: 1,
      opacity: 1,
    },
    {
      id: 'pip-green',
      url: `/files/input/${path.basename(overlayClip)}`,
      trimStart: 0,
      trimEnd: 0.8,
      layerIndex: 1,
      trackOrder: 1,
      timelineStart: 0.4,
      timelineEnd: 1.2,
      x: 35,
      y: 28,
      scale: 0.25,
      opacity: 1,
    },
  ];
  const renderPlan = {
    version: 1,
    duration: 2,
    capabilities: { timelineLayerCompose: true, timelineLayerCount: 2 },
    tracks: [],
    clips,
    audio: [],
    text: [],
    unsupported: [],
    warnings: [],
  };

  let outputFile = '';
  try {
    const result = await videoOpsRouter._test.composeVideoEdit(
      clips,
      {
        aspect: '16:9',
        resolution: 'first',
        transition: 'fade',
        transitionDuration: 0.3,
        filter: 'none',
        audio: 'keep',
      },
      undefined,
      { renderPlan },
    );

    assert.equal(result.transitionEngine, 'timeline-layer-xfade');
    assert.equal(result.transitionName, 'fade');
    assert.equal(result.transitionQuality, 'native-xfade+timeline-overlay');
    assert.equal(result.transitionDuration, 0.3);
    assert.equal(result.timelineVideoComposited, true);
    assert.equal(result.timelineVideoTransitionApplied, true);
    assert.equal(result.timelineVideoTransitionClipCount, 2);
    assert.equal(result.timelineVideoClipCount, 3);
    assert.equal(result.timelineVideoLayerCount, 2);
    assert.equal(result.timelineVideoPipCount, 1);

    outputFile = path.join(config.OUTPUT_DIR, path.basename(result.videoUrl));
    const probe = await videoOpsRouter._test.probeFile(outputFile, null);
    assert.equal(probe.hasAudio, true);
    assert.equal(probe.width, 160);
    assert.equal(probe.height, 90);
    assert.ok(probe.duration >= 1.55 && probe.duration <= 1.85, `expected xfade timeline duration around 1.7s, got ${probe.duration}`);
  } finally {
    for (const file of [redClip, blueClip, overlayClip, outputFile]) {
      if (file) {
        try { fs.unlinkSync(file); } catch (_) {}
      }
    }
  }
});

test('videoOps keeps native xfade duration when mixing timeline render plan audio', async () => {
  fs.mkdirSync(config.INPUT_DIR, { recursive: true });
  fs.mkdirSync(config.OUTPUT_DIR, { recursive: true });

  const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const redClip = path.join(config.INPUT_DIR, `video_edit_xfade_audio_red_${stamp}.mp4`);
  const blueClip = path.join(config.INPUT_DIR, `video_edit_xfade_audio_blue_${stamp}.mp4`);
  const audio = path.join(config.INPUT_DIR, `video_edit_xfade_audio_bgm_${stamp}.m4a`);

  runFfmpeg([
    '-y',
    '-f', 'lavfi', '-i', 'color=c=red:s=160x90:r=30:d=1.0',
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    redClip,
  ]);
  runFfmpeg([
    '-y',
    '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=30:d=1.0',
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    blueClip,
  ]);
  runFfmpeg([
    '-y',
    '-f', 'lavfi', '-i', 'sine=frequency=520:duration=2.0',
    '-c:a', 'aac',
    audio,
  ]);

  const clips = [
    {
      id: 'base-red',
      url: `/files/input/${path.basename(redClip)}`,
      trimStart: 0,
      trimEnd: 1,
      muted: true,
      layerIndex: 0,
      trackOrder: 0,
      timelineStart: 0,
      timelineEnd: 1,
    },
    {
      id: 'base-blue',
      url: `/files/input/${path.basename(blueClip)}`,
      trimStart: 0,
      trimEnd: 1,
      muted: true,
      layerIndex: 0,
      trackOrder: 0,
      timelineStart: 1,
      timelineEnd: 2,
    },
  ];
  const renderPlan = {
    version: 1,
    duration: 2,
    capabilities: { timelineLayerCompose: true, timelineLayerCount: 1 },
    tracks: [],
    clips,
    audio: [
      {
        id: 'bgm-audio',
        sourceItemId: 'bgm-audio',
        timelineStart: 0,
        timelineEnd: 2,
        trimStart: 0,
        trimEnd: 2,
        muted: false,
        volume: 1,
        url: `/files/input/${path.basename(audio)}`,
      },
    ],
    text: [],
    unsupported: [],
    warnings: [],
  };

  let outputFile = '';
  try {
    const result = await videoOpsRouter._test.composeVideoEdit(
      clips,
      {
        aspect: '16:9',
        resolution: 'first',
        transition: 'fade',
        transitionDuration: 0.3,
        filter: 'none',
        audio: 'keep',
      },
      undefined,
      { renderPlan },
    );

    outputFile = path.join(config.OUTPUT_DIR, path.basename(result.videoUrl));
    assert.equal(result.timelineAudioMixed, true);
    assert.equal(result.timelineAudioCount, 1);
    const probe = await videoOpsRouter._test.probeFile(outputFile, null);
    assert.equal(probe.hasAudio, true);
    assert.ok(probe.duration >= 1.55 && probe.duration <= 1.85, `expected mixed xfade output around 1.7s, got ${probe.duration}`);
  } finally {
    for (const file of [redClip, blueClip, audio, outputFile]) {
      if (file) {
        try { fs.unlinkSync(file); } catch (_) {}
      }
    }
  }
});

test('videoOps keeps linked source audio aligned through native xfade transitions', async () => {
  fs.mkdirSync(config.INPUT_DIR, { recursive: true });
  fs.mkdirSync(config.OUTPUT_DIR, { recursive: true });

  const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const firstClip = path.join(config.INPUT_DIR, `video_edit_xfade_linked_audio_first_${stamp}.mp4`);
  const secondClip = path.join(config.INPUT_DIR, `video_edit_xfade_linked_audio_second_${stamp}.mp4`);

  runFfmpeg([
    '-y',
    '-f', 'lavfi', '-i', 'color=c=red:s=160x90:r=30:d=1.0',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1.0',
    '-shortest',
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    firstClip,
  ]);
  runFfmpeg([
    '-y',
    '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=30:d=1.0',
    '-f', 'lavfi', '-i', 'sine=frequency=880:duration=1.0',
    '-shortest',
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    secondClip,
  ]);

  const clips = [
    {
      id: 'render-item-first-video',
      sourceItemId: 'item-first-video',
      assetId: 'asset-first',
      trackId: 'track-video-main',
      kind: 'video',
      layerIndex: 0,
      trackOrder: 0,
      timelineStart: 0,
      timelineEnd: 1,
      trimStart: 0,
      trimEnd: 1,
      muted: false,
      hasAudio: true,
      name: 'first.mp4',
      url: `/files/input/${path.basename(firstClip)}`,
    },
    {
      id: 'render-item-second-video',
      sourceItemId: 'item-second-video',
      assetId: 'asset-second',
      trackId: 'track-video-main',
      kind: 'video',
      layerIndex: 0,
      trackOrder: 0,
      timelineStart: 1,
      timelineEnd: 2,
      trimStart: 0,
      trimEnd: 1,
      muted: false,
      hasAudio: true,
      name: 'second.mp4',
      url: `/files/input/${path.basename(secondClip)}`,
    },
  ];
  const renderPlan = {
    version: 1,
    duration: 2,
    capabilities: { timelineLayerCompose: false, timelineLayerCount: 1, sourceAudioMix: true, timelineAudioMix: true },
    tracks: [],
    clips,
    audio: [
      {
        id: 'render-item-first-audio',
        sourceItemId: 'item-first-audio',
        linkedVideoItemId: 'item-first-video',
        assetId: 'asset-first',
        trackId: 'track-audio-main',
        kind: 'audio',
        trackOrder: 1,
        timelineStart: 0,
        timelineEnd: 1,
        trimStart: 0,
        trimEnd: 1,
        muted: false,
        volume: 1,
        name: 'first audio',
        url: `/files/input/${path.basename(firstClip)}`,
      },
      {
        id: 'render-item-second-audio',
        sourceItemId: 'item-second-audio',
        linkedVideoItemId: 'item-second-video',
        assetId: 'asset-second',
        trackId: 'track-audio-main',
        kind: 'audio',
        trackOrder: 1,
        timelineStart: 1,
        timelineEnd: 2,
        trimStart: 0,
        trimEnd: 1,
        muted: false,
        volume: 1,
        name: 'second audio',
        url: `/files/input/${path.basename(secondClip)}`,
      },
    ],
    text: [],
    unsupported: [],
    warnings: [],
  };

  let outputFile = '';
  try {
    const result = await videoOpsRouter._test.composeVideoEdit(
      clips,
      {
        aspect: '16:9',
        resolution: 'first',
        transition: 'fade',
        transitionDuration: 0.3,
        filter: 'none',
        audio: 'keep',
      },
      undefined,
      { renderPlan },
    );

    outputFile = path.join(config.OUTPUT_DIR, path.basename(result.videoUrl));
    assert.equal(result.transitionEngine, 'ffmpeg-xfade');
    assert.equal(result.timelineAudioMixed, false);
    assert.equal(result.timelineAudioCount, 0);
    const probe = await videoOpsRouter._test.probeFile(outputFile, null);
    assert.equal(probe.hasAudio, true);
    assert.ok(probe.duration >= 1.55 && probe.duration <= 1.85, `expected linked-audio xfade output around 1.7s, got ${probe.duration}`);
    assert.ok(audioRmsAt(outputFile, 1.48, 0.12) > 0.01, 'tail of the second clip should keep audible source audio after transition compaction');
  } finally {
    for (const file of [firstClip, secondClip, outputFile]) {
      if (file) {
        try { fs.unlinkSync(file); } catch (_) {}
      }
    }
  }
});

test('videoOps routes single primary-track visual transforms through timeline layer compose', () => {
  const renderPlan = {
    version: 1,
    duration: 2,
    clips: [
      {
        id: 'primary-render',
        sourceItemId: 'primary',
        layerIndex: 0,
        timelineStart: 0,
        timelineEnd: 2,
        x: 42,
        y: 18,
        scale: 0.74,
        opacity: 0.86,
      },
    ],
  };
  const segments = [
    {
      index: 0,
      duration: 2,
      clip: renderPlan.clips[0],
    },
  ];

  assert.equal(videoOpsRouter._test.shouldComposeTimelineVideoLayers(renderPlan, segments), true);
  assert.equal(videoOpsRouter._test.shouldComposeTimelineVideoLayers(
    { ...renderPlan, clips: [{ ...renderPlan.clips[0], x: 0, y: 0, scale: 1, opacity: 1 }] },
    [{ ...segments[0], clip: { ...renderPlan.clips[0], x: 0, y: 0, scale: 1, opacity: 1 } }],
  ), false);
});

test('videoOps probes stream metadata through bundled ffprobe JSON', async () => {
  fs.mkdirSync(config.INPUT_DIR, { recursive: true });

  const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const clip = path.join(config.INPUT_DIR, `video_probe_json_${stamp}.mp4`);

  try {
    runFfmpeg([
      '-y',
      '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=24:duration=0.8',
      '-f', 'lavfi', '-i', 'sine=frequency=660:duration=0.8',
      '-shortest',
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      clip,
    ]);

    assert.equal(typeof resolveBundledFfprobe, 'function');
    assert.ok(fs.existsSync(resolveBundledFfprobe()), 'ffprobe sidecar must exist for JSON video probing');
    assert.equal(typeof videoOpsRouter._test.probeFile, 'function');

    const probe = await videoOpsRouter._test.probeFile(clip, null);
    assert.equal(probe.probeSource, 'ffprobe-json');
    assert.equal(probe.width, 320);
    assert.equal(probe.height, 180);
    assert.equal(probe.hasAudio, true);
    assert.ok(probe.duration >= 0.7 && probe.duration <= 1.1);
    assert.match(probe.videoCodec || '', /h264/i);
    assert.match(probe.audioCodec || '', /aac/i);
    assert.ok(probe.fps >= 23 && probe.fps <= 25);
    assert.ok(probe.audioChannels >= 1);
  } finally {
    try { fs.unlinkSync(clip); } catch (_) {}
  }
});

test('videoOps exposes native xfade transition graph for high-quality transitions', () => {
  const { getTransitionDefinition, hasNativeXfadeSupport, transitionDurationSeconds, buildXfadeFilterGraph } = videoOpsRouter._test;
  assert.equal(getTransitionDefinition('black').xfade, 'fadeblack');
  assert.equal(getTransitionDefinition('pixelize').xfade, 'pixelize');
  assert.equal(hasNativeXfadeSupport(), true);
  assert.equal(transitionDurationSeconds({ transitionDuration: 0.8 }, [{ duration: 0.5 }, { duration: 1.1 }]), 0.45);

  const graph = buildXfadeFilterGraph(
    [{ file: 'a.mp4', duration: 1.2 }, { file: 'b.mp4', duration: 1.3 }, { file: 'c.mp4', duration: 1.4 }],
    'pixelize',
    0.4,
  );
  assert.match(graph.filterComplex, /xfade=transition=pixelize:duration=0\.400:offset=0\.800/);
  assert.match(graph.filterComplex, /acrossfade=d=0\.400:c1=tri:c2=tri/);
  assert.equal(graph.videoLabel, 'vxf2');
  assert.equal(graph.audioLabel, 'axf2');
});

test('videoOps composes real multi-clip output with native xfade overlap metadata', async () => {
  fs.mkdirSync(config.INPUT_DIR, { recursive: true });
  fs.mkdirSync(config.OUTPUT_DIR, { recursive: true });

  const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const clips = ['red', 'green', 'blue'].map((color, index) => path.join(config.INPUT_DIR, `video_edit_xfade_${color}_${index}_${stamp}.mp4`));

  for (const [index, clip] of clips.entries()) {
    runFfmpeg([
      '-y',
      '-f', 'lavfi', '-i', `color=c=${['red', 'green', 'blue'][index]}:s=160x90:r=30:d=1.2`,
      '-f', 'lavfi', '-i', `sine=frequency=${440 + index * 120}:duration=1.2`,
      '-shortest',
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      clip,
    ]);
  }

  let outputFile = '';
  try {
    const result = await videoOpsRouter._test.composeVideoEdit(
      clips.map((clip) => ({ url: `/files/input/${path.basename(clip)}`, trimStart: 0 })),
      {
        aspect: '16:9',
        resolution: 'first',
        transition: 'pixelize',
        transitionDuration: 0.4,
        filter: 'none',
        audio: 'keep',
      },
    );

    assert.equal(result.transitionEngine, 'ffmpeg-xfade');
    assert.equal(result.transitionName, 'pixelize');
    assert.equal(result.transitionQuality, 'native-xfade');
    assert.equal(result.transitionDuration, 0.4);
    outputFile = path.join(config.OUTPUT_DIR, path.basename(result.videoUrl));
    const probe = await videoOpsRouter._test.probeFile(outputFile, null);
    assert.equal(probe.hasAudio, true);
    assert.equal(probe.width, 160);
    assert.equal(probe.height, 90);
    assert.ok(probe.duration >= 2.65 && probe.duration <= 2.95, `expected xfade overlap duration around 2.8s, got ${probe.duration}`);
  } finally {
    for (const file of [...clips, outputFile]) {
      if (file) {
        try { fs.unlinkSync(file); } catch (_) {}
      }
    }
  }
});

test('videoOps separates audio into real muted video and standalone audio outputs', async () => {
  fs.mkdirSync(config.INPUT_DIR, { recursive: true });
  fs.mkdirSync(config.OUTPUT_DIR, { recursive: true });

  const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const clip = path.join(config.INPUT_DIR, `video_edit_audio_${stamp}.mp4`);
  runFfmpeg([
    '-y',
    '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=12:duration=0.8',
    '-f', 'lavfi', '-i', 'sine=frequency=880:duration=0.8',
    '-shortest',
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    clip,
  ]);

  let mutedFile = '';
  let audioFile = '';
  try {
    const result = await videoOpsRouter._test.separateVideoAudio(
      [{ url: `/files/input/${path.basename(clip)}`, trimStart: 0 }],
      {
        aspect: '16:9',
        resolution: 'first',
        transition: 'none',
        transitionDuration: 0.3,
        filter: 'none',
        audio: 'keep',
      },
      'both',
    );

    assert.match(result.videoUrl, /^\/files\/output\/video_edit_muted_/);
    assert.match(result.audioUrl, /^\/files\/output\/video_edit_audio_/);
    mutedFile = path.join(config.OUTPUT_DIR, path.basename(result.videoUrl));
    audioFile = path.join(config.OUTPUT_DIR, path.basename(result.audioUrl));
    assert.ok(fs.existsSync(mutedFile));
    assert.ok(fs.existsSync(audioFile));
    assert.doesNotMatch(ffmpegInfo(mutedFile), /Audio:/);
    assert.match(ffmpegInfo(audioFile), /Audio:/);
  } finally {
    for (const file of [clip, mutedFile, audioFile]) {
      if (file) {
        try { fs.unlinkSync(file); } catch (_) {}
      }
    }
  }
});

test('videoOps audio separation uses the full workbench render plan audio track', async () => {
  fs.mkdirSync(config.INPUT_DIR, { recursive: true });
  fs.mkdirSync(config.OUTPUT_DIR, { recursive: true });

  const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const clip = path.join(config.INPUT_DIR, `video_edit_separate_plan_video_${stamp}.mp4`);
  const audio = path.join(config.INPUT_DIR, `video_edit_separate_plan_audio_${stamp}.m4a`);
  runFfmpeg([
    '-y',
    '-f', 'lavfi', '-i', 'color=c=black:s=160x90:r=12:d=1.2',
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    clip,
  ]);
  runFfmpeg([
    '-y',
    '-f', 'lavfi', '-i', 'sine=frequency=660:duration=0.8',
    '-c:a', 'aac',
    audio,
  ]);

  let audioFile = '';
  try {
    const renderPlan = {
      version: 1,
      duration: 1.2,
      tracks: [
        { id: 'track-video-main', kind: 'video', name: '视频轨', order: 0 },
        { id: 'track-audio-bgm', kind: 'audio', name: '音频轨', order: 1 },
      ],
      clips: [
        {
          id: 'render-video-silent',
          sourceItemId: 'item-video-silent',
          assetId: 'asset-video-silent',
          trackId: 'track-video-main',
          kind: 'video',
          trackOrder: 0,
          layerIndex: 0,
          timelineStart: 0,
          timelineEnd: 1.2,
          trimStart: 0,
          trimEnd: 1.2,
          muted: true,
          hasAudio: false,
          name: 'silent.mp4',
          url: `/files/input/${path.basename(clip)}`,
        },
      ],
      audio: [
        {
          id: 'render-audio-bgm',
          sourceItemId: 'item-audio-bgm',
          assetId: 'asset-audio-bgm',
          trackId: 'track-audio-bgm',
          kind: 'audio',
          trackOrder: 1,
          timelineStart: 0.15,
          timelineEnd: 0.95,
          trimStart: 0,
          trimEnd: 0.8,
          muted: false,
          volume: 1,
          name: 'bgm.m4a',
          url: `/files/input/${path.basename(audio)}`,
        },
      ],
      text: [],
      warnings: [],
    };

    const result = await videoOpsRouter._test.separateVideoAudio(
      renderPlan.clips,
      {
        aspect: '16:9',
        resolution: 'first',
        transition: 'none',
        transitionDuration: 0.3,
        filter: 'none',
        audio: 'keep',
      },
      'audio-only',
      undefined,
      { renderPlan },
    );

    assert.match(result.audioUrl, /^\/files\/output\/video_edit_audio_/);
    audioFile = path.join(config.OUTPUT_DIR, path.basename(result.audioUrl));
    assert.ok(fs.existsSync(audioFile));
    const probe = await videoOpsRouter._test.probeFile(audioFile, null);
    assert.equal(probe.hasAudio, true);
    assert.ok(probe.duration >= 1 && probe.duration <= 1.4, `expected extracted timeline audio around 1.2s, got ${probe.duration}`);
  } finally {
    for (const file of [clip, audio, audioFile]) {
      if (file) {
        try { fs.unlinkSync(file); } catch (_) {}
      }
    }
  }
});

test('videoOps snapshots a real video frame into an output image', async () => {
  fs.mkdirSync(config.INPUT_DIR, { recursive: true });
  fs.mkdirSync(config.OUTPUT_DIR, { recursive: true });

  const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const clip = path.join(config.INPUT_DIR, `video_edit_snapshot_${stamp}.mp4`);
  runFfmpeg([
    '-y',
    '-f', 'lavfi', '-i', 'testsrc=size=180x100:rate=12:duration=0.8',
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    clip,
  ]);

  let outputFile = '';
  try {
    const result = await videoOpsRouter._test.snapshotVideoFrame(
      { url: `/files/input/${path.basename(clip)}`, trimStart: 0 },
      0.3,
      { format: 'png', sourceLabel: '集成测试片段' },
    );

    assert.match(result.imageUrl, /^\/files\/output\/video_snapshot_/);
    assert.equal(result.mime, 'image/png');
    assert.equal(result.time, 0.3);
    assert.equal(result.sourceLabel, '集成测试片段');
    outputFile = path.join(config.OUTPUT_DIR, path.basename(result.imageUrl));
    assert.ok(fs.existsSync(outputFile));
    assert.ok(fs.statSync(outputFile).size > 100);
  } finally {
    try { fs.unlinkSync(clip); } catch (_) {}
    if (outputFile) {
      try { fs.unlinkSync(outputFile); } catch (_) {}
    }
  }
});

test('videoOps creates filmstrip frames and waveform peaks for timeline trimming previews', async () => {
  fs.mkdirSync(config.INPUT_DIR, { recursive: true });
  fs.mkdirSync(config.THUMBNAILS_DIR, { recursive: true });

  const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const clip = path.join(config.INPUT_DIR, `video_edit_timeline_${stamp}.mp4`);
  runFfmpeg([
    '-y',
    '-f', 'lavfi', '-i', 'testsrc=size=180x100:rate=12:duration=1.2',
    '-f', 'lavfi', '-i', 'sine=frequency=660:duration=1.2',
    '-shortest',
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    clip,
  ]);

  let frameFiles = [];
  try {
    const result = await videoOpsRouter._test.createTimelinePreview(
      { url: `/files/input/${path.basename(clip)}`, name: 'timeline-test.mp4' },
      { frameCount: 5, peakCount: 24 },
    );

    assert.equal(result.filmstripUrls.length, 5);
    assert.equal(result.filmstripTimes.length, 5);
    assert.ok(result.duration >= 1);
    assert.equal(result.hasAudio, true);
    assert.ok(result.waveformPeaks.length >= 16);
    assert.ok(result.waveformPeaks.every((value) => value >= 0 && value <= 1));
    frameFiles = result.filmstripUrls.map((url) => path.join(config.THUMBNAILS_DIR, path.basename(url)));
    frameFiles.forEach((file) => {
      assert.ok(fs.existsSync(file));
      assert.ok(fs.statSync(file).size > 100);
    });
  } finally {
    try { fs.unlinkSync(clip); } catch (_) {}
    for (const file of frameFiles) {
      try { fs.unlinkSync(file); } catch (_) {}
    }
  }
});

test('videoOps target size supports creator aspect presets without 4:5', () => {
  const { targetSize } = videoOpsRouter._test;
  assert.deepEqual(targetSize({ aspect: '3:4', resolution: '1080p' }, { width: 1920, height: 1080 }), { width: 1440, height: 1920 });
  assert.deepEqual(targetSize({ aspect: '4:3', resolution: '1080p' }, { width: 1920, height: 1080 }), { width: 1920, height: 1440 });
  assert.deepEqual(targetSize({ aspect: '21:9', resolution: '1080p' }, { width: 1920, height: 1080 }), { width: 1920, height: 824 });
  assert.deepEqual(targetSize({ aspect: '2:1', resolution: '1080p' }, { width: 1920, height: 1080 }), { width: 1920, height: 960 });
  assert.deepEqual(targetSize({ aspect: '4:5', resolution: '1080p' }, { width: 640, height: 360 }), { width: 1920, height: 1080 });
});

test('videoOps async compose starts a cancellable job and exposes final result for polling clients', async () => {
  fs.mkdirSync(config.INPUT_DIR, { recursive: true });
  fs.mkdirSync(config.OUTPUT_DIR, { recursive: true });

  const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const clip = path.join(config.INPUT_DIR, `video_edit_async_${stamp}.mp4`);
  runFfmpeg([
    '-y',
    '-f', 'lavfi', '-i', 'color=c=green:s=90x120:r=12:d=0.4',
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    clip,
  ]);

  const { server, baseUrl } = await listenVideoOps();
  let outputFile = '';
  try {
    const startRes = await fetch(`${baseUrl}/api/video-ops/compose`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        async: true,
        clips: [{ url: `/files/input/${path.basename(clip)}`, trimStart: 0 }],
        settings: {
          aspect: '3:4',
          resolution: '720p',
          transition: 'none',
          transitionDuration: 0.3,
          filter: 'bright',
          audio: 'mute',
        },
      }),
    });
    const startJson = await startRes.json();
    assert.equal(startRes.status, 200);
    assert.equal(startJson.success, true);
    assert.match(startJson.data.id, /^video-edit-/);
    assert.equal(startJson.data.status, 'running');

    let job = startJson.data;
    for (let i = 0; i < 40 && job.status === 'running'; i += 1) {
      await delay(250);
      const jobRes = await fetch(`${baseUrl}/api/video-ops/jobs/${encodeURIComponent(job.id)}`);
      const jobJson = await jobRes.json();
      assert.equal(jobJson.success, true);
      job = jobJson.data;
    }

    assert.equal(job.status, 'done', job.error || job.message);
    assert.match(job.result.videoUrl, /^\/files\/output\/video_edit_/);
    assert.equal(job.result.width, 960);
    assert.equal(job.result.height, 1280);
    outputFile = path.join(config.OUTPUT_DIR, path.basename(job.result.videoUrl));
    assert.ok(fs.existsSync(outputFile));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    try { fs.unlinkSync(clip); } catch (_) {}
    if (outputFile) {
      try { fs.unlinkSync(outputFile); } catch (_) {}
    }
  }
});

test('videoOps job lifecycle records terminal state and cleans old finished jobs', () => {
  const {
    makeJob,
    finishJob,
    failJob,
    cancelJob,
    cleanupFinishedJobs,
    getJobForTest,
  } = videoOpsRouter._test;

  assert.equal(typeof makeJob, 'function');
  assert.equal(typeof finishJob, 'function');
  assert.equal(typeof failJob, 'function');
  assert.equal(typeof cancelJob, 'function');
  assert.equal(typeof cleanupFinishedJobs, 'function');
  assert.equal(typeof getJobForTest, 'function');

  const now = Date.now();
  const done = makeJob('test-done');
  const failed = makeJob('test-failed');
  const cancelled = makeJob('test-cancelled');
  const running = makeJob('test-running');

  finishJob(done, '测试完成', { ok: true }, now - 90_000);
  failJob(failed, new Error('ffmpeg failed hard'), '测试失败', now - 90_000);
  cancelJob(cancelled, '用户取消', now - 90_000);
  running.createdAt = now - 90_000;
  running.updatedAt = now - 90_000;

  assert.equal(getJobForTest(done.id).status, 'done');
  assert.equal(getJobForTest(done.id).finishedAt, now - 90_000);
  assert.equal(getJobForTest(failed.id).status, 'failed');
  assert.equal(getJobForTest(failed.id).errorCode, 'ffmpeg-failed');
  assert.equal(getJobForTest(cancelled.id).status, 'cancelled');
  assert.equal(getJobForTest(cancelled.id).errorCode, 'cancelled');

  cleanupFinishedJobs(now, 60_000);

  assert.equal(getJobForTest(done.id), null);
  assert.equal(getJobForTest(failed.id), null);
  assert.equal(getJobForTest(cancelled.id), null);
  assert.equal(getJobForTest(running.id).status, 'running');

  cancelJob(running, '测试结束清理', now);
  cleanupFinishedJobs(now + 60_001, 60_000);
  assert.equal(getJobForTest(running.id), null);
});
