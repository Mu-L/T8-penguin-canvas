import type { VideoEditClip, VideoEditSettings, VideoEditTimelineRenderPlan, VideoEditTimelineV2 } from '../utils/videoEdit';
import type { VideoEditExecutionInputSnapshot } from '../utils/videoEditExecution';

function looksLikeHtmlRouteMiss(text: string): boolean {
  return /<\s*!DOCTYPE html|<\s*html/i.test(text) && /Cannot POST\s+\/api\/video-ops\//i.test(text);
}

function videoOpRouteMissMessage(path: string, text: string): string {
  const match = text.match(/Cannot POST\s+([^<\s]+)/i);
  const route = match?.[1] || `/api/video-ops/${path}`;
  return `视频剪辑后端接口未更新或未启动：${route} 不可用。请重启后端服务或重新打开 Electron 后再试。`;
}

async function postVideoOp<T>(path: string, payload: Record<string, any>, options: { signal?: AbortSignal } = {}): Promise<T> {
  const res = await fetch(`/api/video-ops/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: options.signal,
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    if (looksLikeHtmlRouteMiss(text)) {
      throw new Error(videoOpRouteMissMessage(path, text));
    }
    throw new Error(`视频剪辑接口返回异常: ${text.slice(0, 160)}`);
  }
  if (!res.ok || !json?.success) {
    throw new Error(json?.error || json?.message || `HTTP ${res.status}`);
  }
  return json.data as T;
}

export interface VideoProbeResult {
  duration?: number;
  width?: number;
  height?: number;
  fps?: number;
  rotation?: number;
  hasVideo?: boolean;
  hasAudio?: boolean;
  audioStreamCount?: number;
  videoCodec?: string;
  audioCodec?: string;
  audioSampleRate?: number;
  audioChannels?: number;
  formatName?: string;
  bitRate?: number;
  probeSource?: 'ffprobe-json' | 'ffmpeg-stderr';
  thumbnailUrl?: string;
  size?: number;
  mime?: string;
  contentHash?: string;
}

export interface VideoComposeResult {
  jobId: string;
  mode?: 'audio-only' | 'mute-video' | 'both';
  videoUrl: string;
  directVideoUrl?: string;
  fileName: string;
  size?: number;
  duration?: number;
  width?: number;
  height?: number;
  mime?: string;
  audioUrl?: string;
  directAudioUrl?: string;
  audioFileName?: string;
  audioSize?: number;
  audioMime?: string;
  transitionEngine?: 'concat' | 'ffmpeg-xfade' | 'timeline-layer' | 'timeline-layer-xfade';
  transitionName?: string;
  transitionQuality?: string;
  transitionDuration?: number;
  timelineVideoComposited?: boolean;
  timelineVideoClipCount?: number;
  timelineVideoLayerCount?: number;
  timelineVideoPipCount?: number;
  timelineVideoDuration?: number;
  timelineVideoTransitionApplied?: boolean;
  timelineVideoTransitionClipCount?: number;
  timelineVideoTransitionSkippedReason?: string;
  subtitleBurnedIn?: boolean;
  subtitleCount?: number;
  timelineAudioMixed?: boolean;
  timelineAudioCount?: number;
  audioStreamCount?: number;
  masterAudioSourceSha256?: string;
  masterAudioSourceDuration?: number;
  masterAudioReplaced?: boolean;
  masterAudioMode?: 'single-pass-transcode';
}

export interface MvAudioSliceReceipt {
  schema: 't8-mv-audio-slice-receipt-v1';
  segmentId: string;
  sourceSongSha256: string;
  sourceStartUs: number;
  sourceEndUs: number;
  expectedDurationUs: number;
  actualDurationUs: number;
  audioUrl: string;
  byteLength: number;
  sampleRate?: number;
  channels?: number;
  sha256: string;
  createdAt: number;
}

export interface VideoSnapshotResult {
  jobId?: string;
  imageUrl: string;
  directImageUrl?: string;
  fileName: string;
  size?: number;
  mime?: string;
  time: number;
  sourceLabel?: string;
  sourceName?: string;
  sourceUrl?: string;
  width?: number;
  height?: number;
}

export interface VideoTimelinePreviewResult {
  jobId?: string;
  duration?: number;
  width?: number;
  height?: number;
  fps?: number;
  rotation?: number;
  videoCodec?: string;
  audioCodec?: string;
  hasAudio?: boolean;
  filmstripUrls: string[];
  filmstripTimes: number[];
  waveformPeaks: number[];
}

export interface VideoJobStatus {
  id: string;
  status: 'idle' | 'queued' | 'running' | 'done' | 'failed' | 'cancelled' | 'interrupted';
  progress: number;
  message?: string;
  createdAt?: number;
  updatedAt?: number;
  finishedAt?: number | null;
  result?: VideoComposeResult;
  error?: string;
  errorCode?: 'cancelled' | 'download-failed' | 'probe-failed' | 'ffmpeg-failed' | 'invalid-input' | 'video-ops-failed';
  durableEvidence?: VideoOperationExecutionEvidence;
}

export interface VideoOperationExecutionEvidence {
  schema: 't8-video-operation-execution-v1';
  projectId: string;
  canvasId: string;
  runId: string;
  nodeRunId: string;
  attemptId: string;
  nodeId: string;
  requestId: string;
  actionId: 'video-edit.compose' | 'video-edit.platform-export';
  actionTarget: 'compose' | 'platform-export';
  actionDigest: string;
  inputDigest: string;
  operationIndex: number;
}

export interface VideoComposeOptions {
  timelineV2?: VideoEditTimelineV2;
  renderPlan?: VideoEditTimelineRenderPlan;
  executionEvidence?: VideoOperationExecutionEvidence;
  executionInput?: VideoEditExecutionInputSnapshot;
}

export function probeVideo(videoUrl: string, options: { signal?: AbortSignal } = {}): Promise<VideoProbeResult> {
  return postVideoOp<VideoProbeResult>('probe', { videoUrl }, options);
}

export function materializeMvAudioSlice(input: {
  audioUrl: string;
  segmentId: string;
  sourceSongSha256: string;
  startUs: number;
  endUs: number;
}, options: { signal?: AbortSignal } = {}): Promise<MvAudioSliceReceipt> {
  return postVideoOp<MvAudioSliceReceipt>('mv/audio-slice', input, options);
}

export function composeVideoEdit(clips: VideoEditClip[], settings: VideoEditSettings, options: VideoComposeOptions = {}): Promise<VideoComposeResult> {
  return postVideoOp<VideoComposeResult>('compose', { clips, settings, ...options });
}

export function composeVideoEditAsync(clips: VideoEditClip[], settings: VideoEditSettings, options: VideoComposeOptions = {}, requestOptions: { signal?: AbortSignal } = {}): Promise<VideoJobStatus> {
  return postVideoOp<VideoJobStatus>('compose', { clips, settings, async: true, ...options }, requestOptions);
}

export function separateVideoAudioAsync(
  clips: VideoEditClip[],
  settings: VideoEditSettings,
  mode: 'audio-only' | 'mute-video' | 'both',
  options: VideoComposeOptions = {},
): Promise<VideoJobStatus> {
  return postVideoOp<VideoJobStatus>('separate-audio', { clips, settings, mode, async: true, ...options });
}

export function snapshotVideoFrameAsync(
  clip: VideoEditClip,
  time: number,
  options: { format?: 'png' | 'jpg'; sourceLabel?: string } = {},
): Promise<VideoSnapshotResult> {
  return postVideoOp<VideoSnapshotResult>('snapshot', {
    clip,
    time,
    format: options.format || 'png',
    sourceLabel: options.sourceLabel || clip.name || clip.sourceLabel,
  });
}

export function loadVideoTimelinePreviewAsync(
  clip: VideoEditClip,
  options: { frameCount?: number; peakCount?: number } = {},
): Promise<VideoTimelinePreviewResult> {
  return postVideoOp<VideoTimelinePreviewResult>('timeline-preview', { clip, options });
}

export async function getVideoEditJob(jobId: string, options: { signal?: AbortSignal } = {}): Promise<VideoJobStatus> {
  const res = await fetch(`/api/video-ops/jobs/${encodeURIComponent(jobId)}`, { signal: options.signal });
  const json = await res.json();
  if (!res.ok || !json?.success) throw new Error(json?.error || `HTTP ${res.status}`);
  return json.data as VideoJobStatus;
}

export function cancelVideoEditJob(jobId: string): Promise<VideoJobStatus> {
  return postVideoOp<VideoJobStatus>(`jobs/${encodeURIComponent(jobId)}/cancel`, {});
}
