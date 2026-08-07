import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import sharp from 'sharp';
import {
  buildMvPromptSegmentInputs,
  buildMvSegmentBatchMessages,
  buildMvVisualBibleMessages,
  compileMvSeedancePrompt,
  parseMvLyrics,
  parseMvStructuredJson,
  solveMvSegmentation,
  validateMvPromptBatch,
  validateMvSegmentationPlan,
  validateMvVisualBible,
  type MvCreativeBrief,
  type MvLlmMessage,
} from '../src/utils/mvMusicMaster';

const require = createRequire(import.meta.url);
const seedanceNz = require('../backend/src/providers/seedanceNz');
const videoOpsRouter = require('../backend/src/routes/videoOps');
const config = require('../backend/src/config');

const apiKey = String(process.env.SEEDANCE_NZ_API_KEY || '').trim();
const checkpointOnly = !apiKey;
let newPaidSubmissions = 0;
const requireApiKey = (action: string) => {
  if (apiKey) return apiKey;
  throw new Error(`saved checkpoint is incomplete for ${action}; SEEDANCE_NZ_API_KEY is required only when intentionally creating a new paid smoke run`);
};

const ROOT = path.resolve(import.meta.dirname, '..');
const FFMPEG = path.join(ROOT, 'tools', 'ffmpeg-runtime', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
const FFMPEG_COMPAT = videoOpsRouter._test.resolveVideoOpsCompatibilityFfmpeg(FFMPEG);
const runName = String(process.env.MV_MUSIC_MASTER_LIVE_RUN || `mv-music-master-live-${new Date().toISOString().replace(/[:.]/g, '-')}`).trim();
const outputDir = path.join(config.OUTPUT_DIR, runName);
const stateFile = path.join(outputDir, 'state.private.json');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 't8-mv-master-live-'));
fs.mkdirSync(config.INPUT_DIR, { recursive: true });
fs.mkdirSync(outputDir, { recursive: true });

const createdInputFiles: string[] = [];
const sha256 = (value: Buffer | string) => crypto.createHash('sha256').update(value).digest('hex');
const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

interface LiveState {
  schema: 't8-mv-music-master-live-state-v1';
  bible?: ReturnType<typeof validateMvVisualBible>;
  promptPack?: ReturnType<typeof validateMvPromptBatch>[number];
  image?: { taskId: string; status: 'submitted' | 'succeeded' };
  video?: { taskId: string; status: 'submitted' | 'succeeded' };
}

function loadState(): LiveState {
  if (!fs.existsSync(stateFile)) return { schema: 't8-mv-music-master-live-state-v1' };
  const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf8')) as LiveState;
  if (parsed?.schema !== 't8-mv-music-master-live-state-v1') throw new Error('live state schema mismatch');
  return parsed;
}

function saveState(state: LiveState) {
  fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`);
}

function run(command: string, args: string[], label: string, encoding: BufferEncoding | null = 'utf8') {
  const result = spawnSync(command, args, { encoding: encoding as any, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || '').trim().slice(0, 500);
    throw new Error(`${label} failed${detail ? `: ${detail}` : ''}`);
  }
  return result;
}

async function createFixtures() {
  const identity = path.join(tempDir, 'identity.png');
  const style = path.join(tempDir, 'style.png');
  const song = path.join(config.INPUT_DIR, `${runName}-原曲.wav`);
  createdInputFiles.push(song);
  await sharp({ create: { width: 1024, height: 1024, channels: 4, background: '#15233b' } })
    .composite([{ input: Buffer.from('<svg width="1024" height="1024" xmlns="http://www.w3.org/2000/svg"><circle cx="512" cy="355" r="185" fill="#f1caa5"/><path d="M300 350Q330 100 512 110Q715 105 735 355Q655 245 512 250Q380 245 300 350Z" fill="#17212f"/><ellipse cx="445" cy="360" rx="22" ry="14" fill="#17212f"/><ellipse cx="580" cy="360" rx="22" ry="14" fill="#17212f"/><path d="M450 465Q512 505 575 465" fill="none" stroke="#aa5960" stroke-width="15" stroke-linecap="round"/><path d="M250 1024Q270 585 512 565Q755 585 775 1024Z" fill="#d14f72"/></svg>') }])
    .png().toFile(identity);
  await sharp({ create: { width: 1024, height: 1024, channels: 4, background: '#090b1d' } })
    .composite([{ input: Buffer.from('<svg width="1024" height="1024" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#27135f"/><stop offset="0.48" stop-color="#dd407d"/><stop offset="1" stop-color="#36d9d3"/></linearGradient></defs><rect width="1024" height="1024" fill="url(#g)"/><circle cx="220" cy="230" r="150" fill="#ffd580" opacity=".75"/><path d="M0 820Q220 600 420 775T800 650T1024 730V1024H0Z" fill="#10152c"/><path d="M0 875Q250 675 470 850T860 710T1024 820" fill="none" stroke="#f7b4d5" stroke-width="18" opacity=".55"/></svg>') }])
    .png().toFile(style);
  run(FFMPEG_COMPAT, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=44100:duration=5',
    '-filter:a', 'volume=0.32', '-c:a', 'pcm_s16le', '-ar', '44100', '-ac', '2', song,
  ], 'song fixture');
  return { identity, style, song };
}

async function callLlm(messages: MvLlmMessage[] | Array<Record<string, unknown>>, maxTokens: number) {
  const credential = requireApiKey('LLM generation');
  newPaidSubmissions += 1;
  const response = await fetch('https://api.seedance.nz/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${credential}` },
    body: JSON.stringify({
      model: 'bytedance/doubao-seed-2.1-pro',
      messages,
      temperature: 0.55,
      max_tokens: maxTokens,
      stream: false,
    }),
    signal: AbortSignal.timeout(5 * 60_000),
  });
  const data: any = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`default LLM HTTP ${response.status}: ${String(data?.error?.message || data?.message || 'request failed').slice(0, 300)}`);
  const choice = data?.choices?.[0];
  const finishReason = String(choice?.finish_reason || choice?.finishReason || '').toLowerCase();
  if (['length', 'max_tokens', 'content_length'].includes(finishReason)) throw new Error('default LLM response was truncated');
  const content = typeof choice?.message?.content === 'string' ? choice.message.content.trim() : '';
  if (!content) throw new Error('default LLM returned no text content');
  return { content, finishReason, usage: data?.usage || null };
}

async function pollImage(taskId: string) {
  const credential = requireApiKey('storyboard task polling');
  const deadline = Date.now() + 45 * 60_000;
  let lastStatus = '';
  while (Date.now() < deadline) {
    const result = await seedanceNz.queryImageTask(taskId, credential);
    if (result.status !== lastStatus) {
      lastStatus = result.status;
      console.log(`[mv-live:image] ${lastStatus}`);
    }
    if (result.status === 'failed') throw new Error(`storyboard image failed: ${String(result.failReason || 'Provider failure').slice(0, 300)}`);
    if (result.status === 'succeeded') {
      if (!result.imageUrls?.[0]) throw new Error('storyboard image succeeded without URL');
      return result.imageUrls[0] as string;
    }
    await sleep(4_000);
  }
  throw new Error('storyboard image polling timed out');
}

async function pollVideo(taskId: string) {
  const credential = requireApiKey('segment-video task polling');
  const deadline = Date.now() + 45 * 60_000;
  let lastStatus = '';
  while (Date.now() < deadline) {
    const result = await seedanceNz.queryTask(taskId, credential);
    if (result.status !== lastStatus) {
      lastStatus = result.status;
      console.log(`[mv-live:video] ${lastStatus}`);
    }
    if (result.status === 'failed') throw new Error(`segment video failed: ${String(result.failReason || 'Provider failure').slice(0, 300)}`);
    if (result.status === 'succeeded') {
      if (!result.videoUrl) throw new Error('segment video succeeded without URL');
      return result.videoUrl as string;
    }
    await sleep(6_000);
  }
  throw new Error('segment video polling timed out');
}

async function download(url: string, target: string, minimumBytes: number) {
  const response = await seedanceNz.fetchRemote(url);
  if (!response.ok) throw new Error(`media download HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length < minimumBytes) throw new Error(`downloaded media is unexpectedly small (${buffer.length} bytes)`);
  fs.writeFileSync(target, buffer);
  return { bytes: buffer.length, sha256: sha256(buffer) };
}

function probe(file: string) {
  const ffprobe = path.join(ROOT, 'tools', 'ffmpeg-runtime', process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
  const result = run(ffprobe, ['-v', 'error', '-show_entries', 'format=duration,size,format_name', '-show_entries', 'stream=index,codec_type,codec_name,width,height,r_frame_rate', '-of', 'json', file], 'ffprobe');
  return JSON.parse(String(result.stdout || '{}'));
}

async function main() {
  console.log('[mv-live] creating authoritative five-second song and two visual references');
  const fixtures = await createFixtures();
  const parsedLyrics = parseMvLyrics('1\n00:00:00,000 --> 00:00:05,000\n在星光里，我陪你走完这段路。', { format: 'srt', durationUs: 5_000_000 });
  const plan = solveMvSegmentation({ sampleRate: 44_100, totalSamples: 220_500, lyricUnits: parsedLyrics.units });
  const segmentationErrors = validateMvSegmentationPlan(plan, parsedLyrics.units);
  if (segmentationErrors.length) throw new Error(segmentationErrors.join('; '));
  if (plan.segments.length !== 1 || plan.segments[0].durationUs !== 5_000_000) throw new Error('five-second segmentation fixture did not remain exact');

  const brief: MvCreativeBrief = {
    mvType: 'hybrid',
    styleDescription: 'cinematic dream-pop, neon dusk, tactile film grain, expressive but restrained performance',
    creativity: 'balanced',
    shotMode: 'fixed',
    fixedShotCount: 1,
    aspectRatio: '16:9',
    subtitles: 'lyrics',
    identityLock: 'strict',
  };
  const segments = buildMvPromptSegmentInputs(plan, parsedLyrics.units, brief);

  const state = loadState();

  let bible = state.bible;
  if (!bible) {
    const credential = requireApiKey('visual reference upload');
    console.log('[mv-live] uploading visual evidence for the default 2.1 multimodal director');
    const [identityUrl, styleUrl] = await Promise.all([
      seedanceNz.uploadMedia(fixtures.identity, 'image', credential, { normalizeImagePng: true, fileName: 'picture_1.png', cacheVariant: `${runName}-identity` }),
      seedanceNz.uploadMedia(fixtures.style, 'image', credential, { normalizeImagePng: true, fileName: 'picture_2.png', cacheVariant: `${runName}-style` }),
    ]);
    const bibleMessages: any[] = buildMvVisualBibleMessages({
      brief,
      segments,
      identityReferences: ['<Subject 1> identity portrait'],
      styleReferences: ['<Style 1> visual style reference'],
    });
    bibleMessages[bibleMessages.length - 1] = {
      ...bibleMessages[bibleMessages.length - 1],
      content: [
        { type: 'text', text: bibleMessages[bibleMessages.length - 1].content },
        { type: 'image_url', image_url: { url: identityUrl } },
        { type: 'image_url', image_url: { url: styleUrl } },
      ],
    };
    console.log('[mv-live] generating and validating visual bible');
    const bibleResult = await callLlm(bibleMessages, 6_000);
    bible = validateMvVisualBible(parseMvStructuredJson(bibleResult.content), segments.map((segment) => segment.segmentId));
    state.bible = bible;
    saveState(state);
  } else {
    bible = validateMvVisualBible(bible, segments.map((segment) => segment.segmentId));
    console.log('[mv-live] resuming from validated visual bible checkpoint');
  }

  let pack = state.promptPack;
  if (!pack) {
    console.log('[mv-live] generating and validating exact-lyrics PromptPack');
    const promptResult = await callLlm(buildMvSegmentBatchMessages({ bible, brief, segments }), 4_000);
    pack = validateMvPromptBatch(parseMvStructuredJson(promptResult.content), segments)[0];
    state.promptPack = pack;
    saveState(state);
  } else {
    pack = validateMvPromptBatch({ schema: 't8-mv-segment-prompt-pack-batch-v1', segments: [pack] }, segments)[0];
    console.log('[mv-live] resuming from validated PromptPack checkpoint');
  }
  if (!pack || pack.lyricsExact !== parsedLyrics.units[0].originalText) throw new Error('LLM changed the authoritative lyric');

  const storyboardFile = path.join(outputDir, 'storyboard.png');
  let storyboardReceipt: { bytes: number; sha256: string };
  if (state.image?.status === 'succeeded' && fs.existsSync(storyboardFile)) {
    const buffer = fs.readFileSync(storyboardFile);
    storyboardReceipt = { bytes: buffer.length, sha256: sha256(buffer) };
    console.log('[mv-live] resuming from decoded storyboard checkpoint');
  } else {
    let imageTaskId = state.image?.taskId || '';
    if (!imageTaskId) {
      const credential = requireApiKey('storyboard image submission');
      console.log('[mv-live] submitting one real G2 I2I storyboard candidate');
      newPaidSubmissions += 1;
      const imageSubmission = await seedanceNz.submitImageTask({
        model: 'zhenzhen-image-g2-i2i',
        prompt: `${pack.shots[0].imagePrompt}\nComposition: ${pack.shots[0].composition}. Action: ${pack.shots[0].action}. Camera: ${pack.shots[0].camera}. Avoid: ${pack.shots[0].negativePrompt}. No lyrics, subtitles, watermarks or UI.`,
        images: [fixtures.identity, fixtures.style],
        ratio: '16:9',
        resolution: '1k',
      }, credential);
      imageTaskId = imageSubmission.taskId;
      state.image = { taskId: imageTaskId, status: 'submitted' };
      saveState(state);
    } else {
      console.log('[mv-live] resuming previously submitted storyboard task');
    }
    const imageUrl = await pollImage(imageTaskId);
    storyboardReceipt = await download(imageUrl, storyboardFile, 1_024);
    state.image = { taskId: imageTaskId, status: 'succeeded' };
    saveState(state);
  }
  const imageMetadata = await sharp(storyboardFile).metadata();
  if (!imageMetadata.width || !imageMetadata.height || !imageMetadata.format) throw new Error('storyboard image did not decode');

  const videoPrompt = compileMvSeedancePrompt({
    segment: segments[0],
    pack,
    identityDescription: 'Preserve the accepted storyboard person, face, hair, clothing, lighting and color language.',
    pictureCount: 1,
    audioReference: true,
  });
  const segmentVideo = path.join(config.INPUT_DIR, `${runName}-segment.mp4`);
  createdInputFiles.push(segmentVideo);
  const persistedSegmentVideo = path.join(outputDir, 'segment.mp4');
  let videoReceipt: { bytes: number; sha256: string };
  if (state.video?.status === 'succeeded' && fs.existsSync(persistedSegmentVideo)) {
    fs.copyFileSync(persistedSegmentVideo, segmentVideo);
    const buffer = fs.readFileSync(segmentVideo);
    videoReceipt = { bytes: buffer.length, sha256: sha256(buffer) };
    console.log('[mv-live] resuming from validated segment video checkpoint');
  } else {
    let videoTaskId = state.video?.taskId || '';
    if (!videoTaskId) {
      const credential = requireApiKey('segment-video submission');
      console.log('[mv-live] submitting one real Seedance 2.0 fast image+audio segment');
      newPaidSubmissions += 1;
      const videoSubmission = await seedanceNz.submitTask({
        model: 'doubao-seedance-2-0-fast-260128',
        prompt: videoPrompt,
        duration: 5,
        ratio: '16:9',
        resolution: '480p',
        generate_audio: false,
        return_last_frame: true,
        refImages: [storyboardFile],
        audios: [fixtures.song],
      }, credential);
      videoTaskId = videoSubmission.taskId;
      state.video = { taskId: videoTaskId, status: 'submitted' };
      saveState(state);
    } else {
      console.log('[mv-live] resuming previously submitted segment-video task');
    }
    const videoUrl = await pollVideo(videoTaskId);
    videoReceipt = await download(videoUrl, segmentVideo, 4_096);
    fs.copyFileSync(segmentVideo, persistedSegmentVideo);
    state.video = { taskId: videoTaskId, status: 'succeeded' };
    saveState(state);
  }
  const segmentProbe = probe(segmentVideo);
  const segmentVideoStream = segmentProbe.streams?.find((stream: any) => stream.codec_type === 'video');
  if (!segmentVideoStream?.width || !segmentVideoStream?.height || Number(segmentProbe.format?.duration || 0) < 4.9) throw new Error('segment video failed physical validation');

  console.log('[mv-live] composing with generated soundtracks muted and the original song mapped once');
  const renderPlan = {
    version: 1,
    duration: 5,
    tracks: [
      { id: 'mv-video-track', kind: 'video', name: 'MV visual', order: 0 },
      { id: 'mv-audio-track', kind: 'audio', name: 'authoritative original song', order: 0 },
      { id: 'mv-subtitle-track', kind: 'text', name: 'authoritative lyrics', order: 0 },
    ],
    clips: [{ id: 'mv-video', sourceItemId: 'mv-video-item', assetId: 'mv-video-asset', trackId: 'mv-video-track', kind: 'video', timelineStart: 0, timelineEnd: 5, trimStart: 0, trimEnd: 5, muted: true, hasAudio: true, url: `/files/input/${path.basename(segmentVideo)}` }],
    audio: [{ id: 'mv-song', sourceItemId: 'mv-song-item', assetId: 'mv-song-asset', trackId: 'mv-audio-track', kind: 'audio', timelineStart: 0, timelineEnd: 5, trimStart: 0, trimEnd: 5, muted: false, volume: 1, audioFadeIn: 0, audioFadeOut: 0, volumeCurve: 'flat', url: `/files/input/${path.basename(fixtures.song)}` }],
    text: [{ id: 'mv-lyrics', sourceItemId: 'mv-lyrics-item', assetId: 'mv-lyrics-asset', trackId: 'mv-subtitle-track', kind: 'text', timelineStart: 0, timelineEnd: 5, trimStart: 0, trimEnd: 5, muted: false, text: parsedLyrics.units[0].originalText, textPosition: 'bottom', textColor: '#ffffff', textFontSize: 46, textBackground: 'rgba(0,0,0,0.45)' }],
    warnings: [],
  };
  const composeResult = await videoOpsRouter._test.composeVideoEdit(renderPlan.clips, {
    aspect: '16:9', resolution: 'first', transition: 'none', transitionDuration: 0, filter: 'none', audio: 'master-audio-replace', targetDuration: 5,
  }, undefined, { renderPlan });
  const composedFile = videoOpsRouter._test.resolveMountedPath(composeResult.videoUrl);
  const finalFile = path.join(outputDir, 'final-mv.mp4');
  fs.copyFileSync(composedFile, finalFile);
  const finalProbe = probe(finalFile);
  const audioStreams = finalProbe.streams?.filter((stream: any) => stream.codec_type === 'audio') || [];
  const videoStreams = finalProbe.streams?.filter((stream: any) => stream.codec_type === 'video') || [];
  if (audioStreams.length !== 1 || videoStreams.length !== 1) throw new Error('final MV must contain exactly one audio stream and one video stream');
  const finalDuration = Number(finalProbe.format?.duration || 0);
  const fpsParts = String(videoStreams[0]?.r_frame_rate || '24/1').split('/').map(Number);
  const fps = fpsParts[1] ? fpsParts[0] / fpsParts[1] : fpsParts[0] || 24;
  if (Math.abs(finalDuration - 5) > (1 / fps) + 0.005) throw new Error(`final MV A/V drift exceeded one frame: ${finalDuration}`);
  if (!composeResult.masterAudioReplaced || composeResult.timelineAudioCount !== 1 || composeResult.audioStreamCount !== 1) throw new Error('master-audio replacement receipt is invalid');
  const masterAudioSha256 = sha256(fs.readFileSync(fixtures.song));
  if (composeResult.masterAudioSourceSha256 !== masterAudioSha256) throw new Error('master-audio source hash does not match the authoritative song');
  if (Math.abs(Number(composeResult.masterAudioSourceDuration || 0) - 5) > 0.001) throw new Error('master-audio source duration does not match the authoritative song');
  if (!composeResult.subtitleBurnedIn || composeResult.subtitleCount !== 1) throw new Error('authoritative lyric subtitle was not burned in');

  const finalBuffer = fs.readFileSync(finalFile);
  const promptBundle = {
    schema: 't8-mv-live-prompt-bundle-v1',
    lyricsExact: parsedLyrics.units[0].originalText,
    segmentDurationUs: plan.segments[0].durationUs,
    bible,
    promptPack: pack,
    seedancePrompt: videoPrompt,
  };
  fs.writeFileSync(path.join(outputDir, 'prompt-bundle.json'), `${JSON.stringify(promptBundle, null, 2)}\n`);
  const report = {
    schema: 't8-mv-music-master-live-report-v1',
    ok: true,
    verifiedAt: new Date().toISOString(),
    provider: 'seedance-nz',
    models: {
      llm: 'bytedance/doubao-seed-2.1-pro',
      image: 'zhenzhen-image-g2-i2i',
      video: 'doubao-seedance-2-0-fast-260128',
    },
    credentialsPersisted: false,
    verificationRun: { checkpointOnly, newPaidSubmissions },
    taskCount: { llm: 2, image: 1, video: 1 },
    candidateQualityReview: {
      required: true,
      accepted: false,
      observedIssue: 'The generated storyboard may contain forbidden visible lyric text; this smoke run proves the provider/media chain, not artistic acceptance. The production node must require inspection and allow regeneration before adoption.',
    },
    segmentation: { count: 1, minimumUs: 5_000_000, maximumUs: 5_000_000, lyricsExact: true },
    storyboard: { file: 'storyboard.png', bytes: storyboardReceipt.bytes, sha256: storyboardReceipt.sha256, format: imageMetadata.format, width: imageMetadata.width, height: imageMetadata.height },
    segmentVideo: { bytes: videoReceipt.bytes, sha256: videoReceipt.sha256, duration: Number(segmentProbe.format?.duration || 0), width: segmentVideoStream.width, height: segmentVideoStream.height, codec: segmentVideoStream.codec_name },
    final: { file: 'final-mv.mp4', bytes: finalBuffer.length, sha256: sha256(finalBuffer), duration: finalDuration, videoStreams: 1, audioStreams: 1, masterAudioMode: composeResult.masterAudioMode, masterAudioSourceSha256: masterAudioSha256, masterAudioSourceDuration: composeResult.masterAudioSourceDuration, subtitleCount: composeResult.subtitleCount },
  };
  fs.writeFileSync(path.join(outputDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  if (checkpointOnly && newPaidSubmissions !== 0) throw new Error('checkpoint-only verification unexpectedly created a paid submission');
  console.log(`[mv-live] verification mode: ${checkpointOnly ? 'checkpoint-only' : 'credentialed'}; new paid submissions: ${newPaidSubmissions}`);
  console.log(`[mv-live] verified real end-to-end chain; sanitized evidence: ${path.relative(ROOT, path.join(outputDir, 'report.json'))}`);
}

let failed = false;
main().catch((error) => {
  failed = true;
  console.error(`[mv-live] verification mode: ${checkpointOnly ? 'checkpoint-only' : 'credentialed'}; new paid submissions before failure: ${newPaidSubmissions}`);
  console.error(`[mv-live] ${error instanceof Error ? error.message : String(error)}`);
}).finally(() => {
  for (const file of createdInputFiles) {
    try { fs.unlinkSync(file); } catch {}
  }
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  if (failed) process.exitCode = 1;
});
