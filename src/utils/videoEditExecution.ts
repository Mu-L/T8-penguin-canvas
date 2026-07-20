import { sha256Hex } from './incrementalSha256.ts';
import type {
  VideoEditClip,
  VideoEditSettings,
  VideoEditTimelineRenderPlan,
  VideoEditTimelineV2,
} from './videoEdit.ts';

export const VIDEO_EDIT_EXECUTION_INPUT_SCHEMA = 't8-video-edit-execution-input-v1' as const;
export type VideoEditExecutionMode = 'compose' | 'platform-export';

export interface VideoEditExecutionInputSnapshot {
  schema: typeof VIDEO_EDIT_EXECUTION_INPUT_SCHEMA;
  mode: VideoEditExecutionMode;
  clips: VideoEditClip[];
  settings: VideoEditSettings;
  timelineV2: VideoEditTimelineV2;
  renderPlan: VideoEditTimelineRenderPlan;
  packageIds: string[];
  operationSettings: VideoEditSettings[];
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function freezeJson<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) freezeJson(child);
  }
  return value;
}

export function createVideoEditExecutionInputSnapshot(input: {
  mode: VideoEditExecutionMode;
  clips: VideoEditClip[];
  settings: VideoEditSettings;
  timelineV2: VideoEditTimelineV2;
  renderPlan: VideoEditTimelineRenderPlan;
  packageIds?: string[];
  operationSettings: VideoEditSettings[];
}): VideoEditExecutionInputSnapshot {
  const snapshot = cloneJson({
    schema: VIDEO_EDIT_EXECUTION_INPUT_SCHEMA,
    mode: input.mode,
    clips: input.clips,
    settings: input.settings,
    timelineV2: input.timelineV2,
    renderPlan: input.renderPlan,
    packageIds: input.packageIds || [],
    operationSettings: input.operationSettings,
  }) as VideoEditExecutionInputSnapshot;
  return freezeJson(snapshot);
}

export function videoEditExecutionInputDigest(snapshot: VideoEditExecutionInputSnapshot): string {
  return `sha256:${sha256Hex(new TextEncoder().encode(stableJson(snapshot)))}`;
}

export function videoEditExecutionInputMatchesDigest(
  snapshot: VideoEditExecutionInputSnapshot,
  digest: string,
): boolean {
  return /^sha256:[a-f0-9]{64}$/.test(digest)
    && videoEditExecutionInputDigest(snapshot) === digest;
}
