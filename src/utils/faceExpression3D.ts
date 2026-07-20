import { FACE_EXPRESSION_LIBRARY_PRESETS } from './faceExpressionPresetLibrary.ts';

export const FACE_EXPRESSION_SCHEMA = 't8-face-expression-state' as const;
export const FACE_EXPRESSION_VERSION = 1 as const;
export const BUILTIN_FACE_ADAPTER_ID = 't8-ict-neutral-head-v1' as const;
export const BUILTIN_FACE_ADAPTER_VERSION = 3 as const;

export const FACE_CHANNELS = [
  'browDownLeft', 'browDownRight', 'browInnerUp', 'browOuterUpLeft', 'browOuterUpRight',
  'cheekPuff', 'cheekSquintLeft', 'cheekSquintRight',
  'eyeBlinkLeft', 'eyeBlinkRight', 'eyeLookDownLeft', 'eyeLookDownRight',
  'eyeLookInLeft', 'eyeLookInRight', 'eyeLookOutLeft', 'eyeLookOutRight',
  'eyeLookUpLeft', 'eyeLookUpRight', 'eyeSquintLeft', 'eyeSquintRight',
  'eyeWideLeft', 'eyeWideRight',
  'jawForward', 'jawLeft', 'jawOpen', 'jawRight',
  'mouthClose', 'mouthDimpleLeft', 'mouthDimpleRight', 'mouthFrownLeft', 'mouthFrownRight',
  'mouthFunnel', 'mouthLeft', 'mouthLowerDownLeft', 'mouthLowerDownRight',
  'mouthPressLeft', 'mouthPressRight', 'mouthPucker', 'mouthRight',
  'mouthRollLower', 'mouthRollUpper', 'mouthShrugLower', 'mouthShrugUpper',
  'mouthSmileLeft', 'mouthSmileRight', 'mouthStretchLeft', 'mouthStretchRight',
  'mouthUpperUpLeft', 'mouthUpperUpRight',
  'noseSneerLeft', 'noseSneerRight', 'tongueOut',
] as const;

export type FaceChannel = typeof FACE_CHANNELS[number];
export type FaceChannelValues = Record<FaceChannel, number>;
export type FaceExpressionTab = 'expression' | 'presets' | 'pose' | 'camera' | 'lighting' | 'output' | 'batch';

export interface FacePhotoCalibration {
  sourceUrl: string;
  analyzedAt: string;
  confidence: number;
  faceWidth: number;
  faceHeight: number;
  jawWidth: number;
  eyeSpacing: number;
  eyeSize: number;
  browHeight: number;
  noseLength: number;
  noseWidth: number;
  mouthWidth: number;
  lipThickness: number;
  skinColor: string;
  hairColor: string;
  irisColor: string;
}

export interface FaceExpressionLight {
  id: 'ambient' | 'key' | 'fill' | 'rim';
  color: string;
  intensity: number;
  azimuth: number;
  elevation: number;
  shadows: boolean;
}

export interface FaceExpressionOutputSettings {
  format: 'png' | 'jpeg' | 'webp';
  transparent: boolean;
  background: {
    kind: 'transparent' | 'color' | 'image';
    value: string;
    fit: 'cover' | 'contain';
    blur: number;
  };
  width: number;
  height: number;
  ratioId: string;
}

export interface FaceExpressionPreset {
  id: string;
  name: string;
  builtin?: boolean;
  channels: Partial<FaceChannelValues>;
}

export interface FaceCameraPreset {
  id: string;
  name: string;
  builtin?: boolean;
  projection: 'perspective' | 'orthographic';
  fov: number;
  position: [number, number, number];
  target: [number, number, number];
}

export interface FaceExpression3DState {
  schema: typeof FACE_EXPRESSION_SCHEMA;
  version: typeof FACE_EXPRESSION_VERSION;
  model: {
    source: 'procedural' | 'upstream';
    sourceUrl: string;
    adapterId: string;
    adapterVersion: number;
    visibleParts: Record<string, boolean>;
    skinColor: string;
    hairColor: string;
    irisColor: string;
    proportions: {
      faceWidth: number;
      faceHeight: number;
      jawWidth: number;
      eyeSpacing: number;
      eyeSize: number;
      browHeight: number;
      noseLength: number;
      noseWidth: number;
      mouthWidth: number;
      lipThickness: number;
    };
    photoCalibration?: FacePhotoCalibration;
  };
  expression: {
    mode: 'replace' | 'add';
    strength: number;
    symmetryLocked: boolean;
    presetId: string;
    channels: FaceChannelValues;
    randomSeed: number;
  };
  pose: {
    head: { pitch: number; yaw: number; roll: number; neckFollow: number };
    eyes: {
      mode: 'manual' | 'camera' | 'target';
      left: [number, number];
      right: [number, number];
      target: [number, number, number];
    };
  };
  camera: {
    projection: 'perspective' | 'orthographic';
    fov: number;
    position: [number, number, number];
    target: [number, number, number];
    framingPreset: string;
    guides: boolean;
  };
  lighting: {
    presetId: string;
    exposure: number;
    environmentIntensity: number;
    lights: FaceExpressionLight[];
  };
  output: FaceExpressionOutputSettings;
  batch: {
    mode: 'pair' | 'cartesian';
    expressionPresetIds: string[];
    cameraPresetIds: string[];
    maxItems: number;
  };
  customPresets: FaceExpressionPreset[];
}

export interface FaceExpressionBatchItem {
  index: number;
  expressionPresetId: string;
  cameraPresetId: string;
  fileLabel: string;
}

export const FACE_CHANNEL_GROUPS: Array<{
  id: string;
  label: string;
  channels: FaceChannel[];
}> = [
  { id: 'brow', label: '眉毛', channels: ['browDownLeft', 'browDownRight', 'browInnerUp', 'browOuterUpLeft', 'browOuterUpRight'] },
  { id: 'eyes', label: '眼睛', channels: ['eyeBlinkLeft', 'eyeBlinkRight', 'eyeSquintLeft', 'eyeSquintRight', 'eyeWideLeft', 'eyeWideRight'] },
  { id: 'gaze', label: '眼球', channels: ['eyeLookUpLeft', 'eyeLookUpRight', 'eyeLookDownLeft', 'eyeLookDownRight', 'eyeLookInLeft', 'eyeLookInRight', 'eyeLookOutLeft', 'eyeLookOutRight'] },
  { id: 'cheek', label: '脸颊 / 鼻', channels: ['cheekPuff', 'cheekSquintLeft', 'cheekSquintRight', 'noseSneerLeft', 'noseSneerRight'] },
  { id: 'jaw', label: '下巴', channels: ['jawOpen', 'jawForward', 'jawLeft', 'jawRight'] },
  { id: 'mouth', label: '嘴', channels: ['mouthSmileLeft', 'mouthSmileRight', 'mouthFrownLeft', 'mouthFrownRight', 'mouthPucker', 'mouthFunnel', 'mouthLeft', 'mouthRight', 'mouthUpperUpLeft', 'mouthUpperUpRight', 'mouthLowerDownLeft', 'mouthLowerDownRight', 'mouthPressLeft', 'mouthPressRight', 'mouthClose', 'mouthDimpleLeft', 'mouthDimpleRight', 'mouthRollLower', 'mouthRollUpper', 'mouthShrugLower', 'mouthShrugUpper', 'mouthStretchLeft', 'mouthStretchRight', 'tongueOut'] },
];

export const FACE_CHANNEL_LABELS: Record<FaceChannel, string> = {
  browDownLeft: '左眉下压', browDownRight: '右眉下压', browInnerUp: '眉心上扬', browOuterUpLeft: '左眉外扬', browOuterUpRight: '右眉外扬',
  cheekPuff: '鼓腮', cheekSquintLeft: '左脸颊提起', cheekSquintRight: '右脸颊提起',
  eyeBlinkLeft: '左眨眼', eyeBlinkRight: '右眨眼', eyeLookDownLeft: '左眼下看', eyeLookDownRight: '右眼下看',
  eyeLookInLeft: '左眼内看', eyeLookInRight: '右眼内看', eyeLookOutLeft: '左眼外看', eyeLookOutRight: '右眼外看',
  eyeLookUpLeft: '左眼上看', eyeLookUpRight: '右眼上看', eyeSquintLeft: '左眼眯起', eyeSquintRight: '右眼眯起',
  eyeWideLeft: '左眼睁大', eyeWideRight: '右眼睁大',
  jawForward: '下巴前伸', jawLeft: '下巴左移', jawOpen: '张口', jawRight: '下巴右移',
  mouthClose: '闭嘴', mouthDimpleLeft: '左酒窝', mouthDimpleRight: '右酒窝', mouthFrownLeft: '左嘴角下压', mouthFrownRight: '右嘴角下压',
  mouthFunnel: '拢嘴', mouthLeft: '嘴左移', mouthLowerDownLeft: '左下唇下压', mouthLowerDownRight: '右下唇下压',
  mouthPressLeft: '左压唇', mouthPressRight: '右压唇', mouthPucker: '嘟嘴', mouthRight: '嘴右移',
  mouthRollLower: '下唇内卷', mouthRollUpper: '上唇内卷', mouthShrugLower: '下唇耸起', mouthShrugUpper: '上唇耸起',
  mouthSmileLeft: '左微笑', mouthSmileRight: '右微笑', mouthStretchLeft: '左嘴角拉伸', mouthStretchRight: '右嘴角拉伸',
  mouthUpperUpLeft: '左上唇提起', mouthUpperUpRight: '右上唇提起',
  noseSneerLeft: '左皱鼻', noseSneerRight: '右皱鼻', tongueOut: '吐舌',
};

function preset(id: string, name: string, channels: Partial<FaceChannelValues>): FaceExpressionPreset {
  return { id, name, builtin: true, channels };
}

export const FACE_EXPRESSION_PRESETS: FaceExpressionPreset[] = [
  preset('neutral', '中性', {}),
  preset('soft-smile', '微笑', { mouthSmileLeft: 0.58, mouthSmileRight: 0.58, cheekSquintLeft: 0.18, cheekSquintRight: 0.18 }),
  preset('laugh', '大笑', { mouthSmileLeft: 0.9, mouthSmileRight: 0.9, jawOpen: 0.55, eyeSquintLeft: 0.36, eyeSquintRight: 0.36, cheekSquintLeft: 0.48, cheekSquintRight: 0.48 }),
  preset('sad', '悲伤', { mouthFrownLeft: 0.72, mouthFrownRight: 0.72, browInnerUp: 0.68, eyeSquintLeft: 0.12, eyeSquintRight: 0.12 }),
  preset('angry', '愤怒', { browDownLeft: 0.82, browDownRight: 0.82, eyeSquintLeft: 0.42, eyeSquintRight: 0.42, mouthPressLeft: 0.45, mouthPressRight: 0.45 }),
  preset('surprised', '惊讶', { browInnerUp: 0.65, browOuterUpLeft: 0.7, browOuterUpRight: 0.7, eyeWideLeft: 0.85, eyeWideRight: 0.85, jawOpen: 0.72, mouthFunnel: 0.22 }),
  preset('disgust', '厌恶', { noseSneerLeft: 0.78, noseSneerRight: 0.78, mouthUpperUpLeft: 0.5, mouthUpperUpRight: 0.5, browDownLeft: 0.35, browDownRight: 0.35 }),
  preset('fear', '恐惧', { eyeWideLeft: 0.72, eyeWideRight: 0.72, browInnerUp: 0.72, jawOpen: 0.38, mouthStretchLeft: 0.44, mouthStretchRight: 0.44 }),
  preset('sleepy', '困倦', { eyeBlinkLeft: 0.58, eyeBlinkRight: 0.58, browInnerUp: 0.12, mouthShrugLower: 0.18 }),
  preset('wink-left', '左眨眼', { eyeBlinkLeft: 1, mouthSmileLeft: 0.48, cheekSquintLeft: 0.3 }),
  preset('doubt', '疑惑', { browOuterUpLeft: 0.75, browDownRight: 0.3, mouthLeft: 0.18, mouthPressRight: 0.28 }),
  preset('pout', '嘟嘴', { mouthPucker: 0.82, mouthFunnel: 0.4, browInnerUp: 0.15 }),
];

export const FACE_CAMERA_PRESETS: FaceCameraPreset[] = [
  { id: 'portrait', name: '头像正面', builtin: true, projection: 'perspective', fov: 32, position: [0, 0.05, 5.25], target: [0, -0.05, 0] },
  { id: 'shoulders', name: '肩部半身', builtin: true, projection: 'perspective', fov: 36, position: [0, -0.2, 6.6], target: [0, -0.45, 0] },
  { id: 'three-quarter', name: '三分之四侧', builtin: true, projection: 'perspective', fov: 34, position: [2.2, 0.12, 5.1], target: [0, -0.08, 0] },
  { id: 'profile-left', name: '左侧面', builtin: true, projection: 'perspective', fov: 35, position: [4.8, 0, 0.35], target: [0, -0.1, 0] },
  { id: 'close-up', name: '面部特写', builtin: true, projection: 'perspective', fov: 28, position: [0, 0.2, 4.35], target: [0, 0.12, 0] },
  { id: 'top', name: '轻俯视', builtin: true, projection: 'perspective', fov: 35, position: [0, 2.1, 5.4], target: [0, -0.18, 0] },
  { id: 'bottom', name: '轻仰视', builtin: true, projection: 'perspective', fov: 35, position: [0, -1.75, 5.5], target: [0, 0.12, 0] },
  { id: 'orthographic', name: '正交证件', builtin: true, projection: 'orthographic', fov: 32, position: [0, 0.05, 5.4], target: [0, -0.08, 0] },
];

export const FACE_LIGHTING_PRESETS: Record<string, { name: string; exposure: number; lights: FaceExpressionLight[] }> = {
  studio: {
    name: '工作室柔光', exposure: 1,
    lights: [
      { id: 'ambient', color: '#fff5e9', intensity: 1.05, azimuth: 0, elevation: 65, shadows: false },
      { id: 'key', color: '#fff1df', intensity: 2.6, azimuth: -34, elevation: 38, shadows: true },
      { id: 'fill', color: '#cce4ff', intensity: 1.15, azimuth: 42, elevation: 16, shadows: false },
      { id: 'rim', color: '#ffd9c2', intensity: 1.45, azimuth: 145, elevation: 36, shadows: false },
    ],
  },
  id: {
    name: '证件均匀光', exposure: 1.06,
    lights: [
      { id: 'ambient', color: '#ffffff', intensity: 1.45, azimuth: 0, elevation: 60, shadows: false },
      { id: 'key', color: '#ffffff', intensity: 1.85, azimuth: -18, elevation: 25, shadows: false },
      { id: 'fill', color: '#ffffff', intensity: 1.7, azimuth: 18, elevation: 25, shadows: false },
      { id: 'rim', color: '#e7f1ff', intensity: 0.72, azimuth: 180, elevation: 35, shadows: false },
    ],
  },
  dramatic: {
    name: '戏剧侧光', exposure: 0.92,
    lights: [
      { id: 'ambient', color: '#1b2340', intensity: 0.35, azimuth: 0, elevation: 60, shadows: false },
      { id: 'key', color: '#ffd0a2', intensity: 4.1, azimuth: -68, elevation: 18, shadows: true },
      { id: 'fill', color: '#203f7a', intensity: 0.45, azimuth: 50, elevation: 6, shadows: false },
      { id: 'rim', color: '#7db8ff', intensity: 2.5, azimuth: 142, elevation: 42, shadows: false },
    ],
  },
  rim: {
    name: '清晰轮廓光', exposure: 0.98,
    lights: [
      { id: 'ambient', color: '#ffffff', intensity: 0.65, azimuth: 0, elevation: 60, shadows: false },
      { id: 'key', color: '#e8f1ff', intensity: 1.7, azimuth: -24, elevation: 35, shadows: true },
      { id: 'fill', color: '#ffd8b8', intensity: 0.8, azimuth: 36, elevation: 12, shadows: false },
      { id: 'rim', color: '#8bd7ff', intensity: 3.3, azimuth: 165, elevation: 28, shadows: false },
    ],
  },
};

export function emptyFaceChannels(): FaceChannelValues {
  return Object.fromEntries(FACE_CHANNELS.map((channel) => [channel, 0])) as FaceChannelValues;
}

function finite(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function clampFaceValue(value: unknown, min = 0, max = 1): number {
  return Math.min(max, Math.max(min, finite(value, min)));
}

function safeColor(value: unknown, fallback: string): string {
  const text = String(value || '').trim();
  return /^#[0-9a-f]{6}$/i.test(text) ? text.toUpperCase() : fallback;
}

function cloneLights(lights: FaceExpressionLight[]): FaceExpressionLight[] {
  return lights.map((light) => ({ ...light }));
}

export function defaultFaceExpressionState(): FaceExpression3DState {
  const camera = FACE_CAMERA_PRESETS[0];
  const lighting = FACE_LIGHTING_PRESETS.studio;
  return {
    schema: FACE_EXPRESSION_SCHEMA,
    version: FACE_EXPRESSION_VERSION,
    model: {
      source: 'procedural',
      sourceUrl: '',
      adapterId: BUILTIN_FACE_ADAPTER_ID,
      adapterVersion: BUILTIN_FACE_ADAPTER_VERSION,
      visibleParts: { hair: false, ears: true, neck: true, shoulders: true, teeth: true },
      skinColor: '#B8BAB8',
      hairColor: '#B8BAB8',
      irisColor: '#536563',
      proportions: {
        faceWidth: 1,
        faceHeight: 1,
        jawWidth: 1,
        eyeSpacing: 1,
        eyeSize: 1,
        browHeight: 1,
        noseLength: 1,
        noseWidth: 1,
        mouthWidth: 1,
        lipThickness: 1,
      },
    },
    expression: {
      mode: 'replace',
      strength: 1,
      symmetryLocked: true,
      presetId: 'neutral',
      channels: emptyFaceChannels(),
      randomSeed: 20260712,
    },
    pose: {
      head: { pitch: 0, yaw: 0, roll: 0, neckFollow: 0.35 },
      eyes: { mode: 'camera', left: [0, 0], right: [0, 0], target: [0, 0, 4] },
    },
    camera: {
      projection: camera.projection,
      fov: camera.fov,
      position: [...camera.position],
      target: [...camera.target],
      framingPreset: camera.id,
      guides: false,
    },
    lighting: {
      presetId: 'studio',
      exposure: lighting.exposure,
      environmentIntensity: 1,
      lights: cloneLights(lighting.lights),
    },
    output: {
      format: 'png',
      transparent: false,
      background: { kind: 'color', value: '#E7EDF2', fit: 'cover', blur: 0 },
      width: 1024,
      height: 1024,
      ratioId: '1:1',
    },
    batch: {
      mode: 'pair',
      expressionPresetIds: ['soft-smile'],
      cameraPresetIds: ['portrait'],
      maxItems: 32,
    },
    customPresets: [],
  };
}

export function normalizeFaceExpressionState(input: unknown): FaceExpression3DState {
  const base = defaultFaceExpressionState();
  const raw = input && typeof input === 'object' ? input as any : {};
  const model = raw.model && typeof raw.model === 'object' ? raw.model : {};
  const expression = raw.expression && typeof raw.expression === 'object' ? raw.expression : {};
  const pose = raw.pose && typeof raw.pose === 'object' ? raw.pose : {};
  const camera = raw.camera && typeof raw.camera === 'object' ? raw.camera : {};
  const lighting = raw.lighting && typeof raw.lighting === 'object' ? raw.lighting : {};
  const output = raw.output && typeof raw.output === 'object' ? raw.output : {};
  const channels = emptyFaceChannels();
  for (const channel of FACE_CHANNELS) channels[channel] = clampFaceValue(expression.channels?.[channel]);
  const proportions = { ...base.model.proportions };
  for (const key of Object.keys(proportions) as Array<keyof typeof proportions>) {
    proportions[key] = clampFaceValue(model.proportions?.[key], 0.68, 1.42);
  }
  const selectedLighting = FACE_LIGHTING_PRESETS[String(lighting.presetId || '')] || FACE_LIGHTING_PRESETS.studio;
  const rawLights = Array.isArray(lighting.lights) ? lighting.lights : selectedLighting.lights;
  const lights = base.lighting.lights.map((fallback) => {
    const candidate = rawLights.find((item: any) => item?.id === fallback.id) || fallback;
    return {
      id: fallback.id,
      color: safeColor(candidate.color, fallback.color),
      intensity: clampFaceValue(candidate.intensity, 0, 8),
      azimuth: clampFaceValue(candidate.azimuth, -180, 180),
      elevation: clampFaceValue(candidate.elevation, -90, 90),
      shadows: Boolean(candidate.shadows),
    };
  });
  const position = Array.isArray(camera.position) && camera.position.length >= 3
    ? camera.position.slice(0, 3).map((v: unknown, i: number) => finite(v, base.camera.position[i])) as [number, number, number]
    : [...base.camera.position] as [number, number, number];
  const target = Array.isArray(camera.target) && camera.target.length >= 3
    ? camera.target.slice(0, 3).map((v: unknown, i: number) => finite(v, base.camera.target[i])) as [number, number, number]
    : [...base.camera.target] as [number, number, number];
  const format = output.format === 'jpeg' || output.format === 'webp' ? output.format : 'png';
  const backgroundKind = output.background?.kind === 'transparent' || output.background?.kind === 'image'
    ? output.background.kind
    : 'color';
  const transparent = Boolean(output.transparent) && format !== 'jpeg';
  const isBuiltin = model.source !== 'upstream';
  const isLegacyDefaultHead = model.source !== 'upstream'
    && model.adapterId === 't8-studio-head-v1'
    && String(model.skinColor || '').toUpperCase() === '#D8A17E'
    && String(model.hairColor || '').toUpperCase() === '#2B211D';
  const isEarlyClayDefault = model.source !== 'upstream'
    && model.adapterId === 't8-neutral-clay-head-v2'
    && String(model.skinColor || '').toUpperCase() === '#D9DAD5'
    && String(model.hairColor || '').toUpperCase() === '#C9CAC5'
    && String(model.irisColor || '').toUpperCase() === '#78888B';
  const visibleParts = { ...base.model.visibleParts, ...(model.visibleParts || {}) };
  if (isLegacyDefaultHead) visibleParts.hair = false;
  return {
    ...base,
    model: {
      ...base.model,
      source: model.source === 'upstream' ? 'upstream' : 'procedural',
      sourceUrl: typeof model.sourceUrl === 'string' ? model.sourceUrl : '',
      adapterId: isBuiltin
        ? base.model.adapterId
        : typeof model.adapterId === 'string' && model.adapterId ? model.adapterId : base.model.adapterId,
      adapterVersion: isBuiltin ? base.model.adapterVersion : Math.max(1, Math.round(finite(model.adapterVersion, base.model.adapterVersion))),
      visibleParts,
      skinColor: isLegacyDefaultHead ? base.model.skinColor : safeColor(model.skinColor, base.model.skinColor),
      hairColor: isLegacyDefaultHead ? base.model.hairColor : safeColor(model.hairColor, base.model.hairColor),
      irisColor: (isLegacyDefaultHead && String(model.irisColor || '').toUpperCase() === '#4B6B78') || isEarlyClayDefault
        ? base.model.irisColor
        : safeColor(model.irisColor, base.model.irisColor),
      proportions,
      photoCalibration: model.photoCalibration && typeof model.photoCalibration === 'object'
        ? { ...model.photoCalibration }
        : undefined,
    },
    expression: {
      mode: expression.mode === 'add' ? 'add' : 'replace',
      strength: clampFaceValue(expression.strength),
      symmetryLocked: expression.symmetryLocked !== false,
      presetId: typeof expression.presetId === 'string' ? expression.presetId : 'neutral',
      channels,
      randomSeed: Math.max(1, Math.round(finite(expression.randomSeed, base.expression.randomSeed))),
    },
    pose: {
      head: {
        pitch: clampFaceValue(pose.head?.pitch, -50, 50),
        yaw: clampFaceValue(pose.head?.yaw, -75, 75),
        roll: clampFaceValue(pose.head?.roll, -45, 45),
        neckFollow: clampFaceValue(pose.head?.neckFollow),
      },
      eyes: {
        mode: pose.eyes?.mode === 'manual' || pose.eyes?.mode === 'target' ? pose.eyes.mode : 'camera',
        left: [clampFaceValue(pose.eyes?.left?.[0], -1, 1), clampFaceValue(pose.eyes?.left?.[1], -1, 1)],
        right: [clampFaceValue(pose.eyes?.right?.[0], -1, 1), clampFaceValue(pose.eyes?.right?.[1], -1, 1)],
        target: Array.isArray(pose.eyes?.target) && pose.eyes.target.length >= 3
          ? pose.eyes.target.slice(0, 3).map((v: unknown, i: number) => finite(v, base.pose.eyes.target[i])) as [number, number, number]
          : [...base.pose.eyes.target],
      },
    },
    camera: {
      projection: camera.projection === 'orthographic' ? 'orthographic' : 'perspective',
      fov: clampFaceValue(camera.fov, 18, 75),
      position,
      target,
      framingPreset: typeof camera.framingPreset === 'string' ? camera.framingPreset : 'portrait',
      guides: Boolean(camera.guides),
    },
    lighting: {
      presetId: typeof lighting.presetId === 'string' ? lighting.presetId : 'studio',
      exposure: clampFaceValue(lighting.exposure, 0.25, 2.5),
      environmentIntensity: clampFaceValue(lighting.environmentIntensity, 0, 3),
      lights,
    },
    output: {
      format,
      transparent,
      background: {
        kind: transparent ? 'transparent' : backgroundKind,
        value: backgroundKind === 'color'
          ? safeColor(output.background?.value, base.output.background.value)
          : String(output.background?.value || ''),
        fit: output.background?.fit === 'contain' ? 'contain' : 'cover',
        blur: clampFaceValue(output.background?.blur, 0, 24),
      },
      width: Math.round(clampFaceValue(output.width, 256, 4096)),
      height: Math.round(clampFaceValue(output.height, 256, 4096)),
      ratioId: typeof output.ratioId === 'string' ? output.ratioId : '1:1',
    },
    batch: {
      mode: raw.batch?.mode === 'cartesian' ? 'cartesian' : 'pair',
      expressionPresetIds: Array.isArray(raw.batch?.expressionPresetIds) ? raw.batch.expressionPresetIds.map(String).filter(Boolean).slice(0, 32) : ['soft-smile'],
      cameraPresetIds: Array.isArray(raw.batch?.cameraPresetIds) ? raw.batch.cameraPresetIds.map(String).filter(Boolean).slice(0, 16) : ['portrait'],
      maxItems: Math.round(clampFaceValue(raw.batch?.maxItems, 1, 64)),
    },
    customPresets: Array.isArray(raw.customPresets)
      ? raw.customPresets.slice(0, 64).map((item: any, index: number) => ({
          id: typeof item?.id === 'string' && item.id ? item.id : `custom-${index + 1}`,
          name: typeof item?.name === 'string' && item.name.trim() ? item.name.trim().slice(0, 48) : `自定义 ${index + 1}`,
          channels: Object.fromEntries(FACE_CHANNELS.filter((channel) => item?.channels?.[channel] != null).map((channel) => [channel, clampFaceValue(item.channels[channel])])) as Partial<FaceChannelValues>,
        }))
      : [],
  };
}

export function allFacePresets(state: FaceExpression3DState): FaceExpressionPreset[] {
  const seen = new Set<string>();
  return [...FACE_EXPRESSION_PRESETS, ...FACE_EXPRESSION_LIBRARY_PRESETS, ...state.customPresets].filter((item) => {
    if (!item.id || seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

export function applyFacePreset(
  state: FaceExpression3DState,
  presetId: string,
  mode: 'replace' | 'add' = state.expression.mode,
): FaceExpression3DState {
  const target = allFacePresets(state).find((item) => item.id === presetId) || FACE_EXPRESSION_PRESETS[0];
  const next = mode === 'add' ? { ...state.expression.channels } : emptyFaceChannels();
  for (const channel of FACE_CHANNELS) {
    const value = target.channels[channel];
    if (value == null) continue;
    next[channel] = mode === 'add' ? clampFaceValue(next[channel] + value) : clampFaceValue(value);
  }
  return normalizeFaceExpressionState({
    ...state,
    expression: { ...state.expression, mode, presetId: target.id, channels: next },
  });
}

export function setFaceChannel(
  state: FaceExpression3DState,
  channel: FaceChannel,
  value: number,
): FaceExpression3DState {
  const channels = { ...state.expression.channels, [channel]: clampFaceValue(value) };
  if (state.expression.symmetryLocked) {
    const mirror = channel.endsWith('Left')
      ? channel.replace(/Left$/, 'Right') as FaceChannel
      : channel.endsWith('Right')
        ? channel.replace(/Right$/, 'Left') as FaceChannel
        : null;
    if (mirror && FACE_CHANNELS.includes(mirror)) channels[mirror] = clampFaceValue(value);
  }
  return normalizeFaceExpressionState({
    ...state,
    expression: { ...state.expression, presetId: 'custom', channels },
  });
}

function seeded(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value += 0x6D2B79F5;
    let t = value;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randomizeFaceExpression(state: FaceExpression3DState, intensity = 0.55): FaceExpression3DState {
  const rng = seeded(state.expression.randomSeed);
  const channels = emptyFaceChannels();
  const active = FACE_CHANNELS.filter((channel) => !channel.startsWith('eyeLook'));
  for (const channel of active) {
    if (rng() < 0.22) channels[channel] = Number((rng() * intensity).toFixed(3));
  }
  return normalizeFaceExpressionState({
    ...state,
    expression: {
      ...state.expression,
      presetId: 'random',
      channels,
      randomSeed: state.expression.randomSeed + 1,
    },
  });
}

export function applyFaceCameraPreset(state: FaceExpression3DState, presetId: string): FaceExpression3DState {
  const target = FACE_CAMERA_PRESETS.find((item) => item.id === presetId) || FACE_CAMERA_PRESETS[0];
  return normalizeFaceExpressionState({
    ...state,
    camera: {
      ...state.camera,
      projection: target.projection,
      fov: target.fov,
      position: [...target.position],
      target: [...target.target],
      framingPreset: target.id,
    },
  });
}

export function applyFaceLightingPreset(state: FaceExpression3DState, presetId: string): FaceExpression3DState {
  const target = FACE_LIGHTING_PRESETS[presetId] || FACE_LIGHTING_PRESETS.studio;
  return normalizeFaceExpressionState({
    ...state,
    lighting: { ...state.lighting, presetId, exposure: target.exposure, lights: cloneLights(target.lights) },
  });
}

export function outputSizeForPreset(id: string, current: FaceExpressionOutputSettings): FaceExpressionOutputSettings {
  const match = /^(\d+)x(\d+)$/.exec(id);
  if (match) return { ...current, width: Number(match[1]), height: Number(match[2]), ratioId: `${match[1]}:${match[2]}` };
  const presets: Record<string, [number, number]> = {
    '1:1-1K': [1024, 1024], '1:1-2K': [2048, 2048], '1:1-4K': [4096, 4096],
    '3:4': [1536, 2048], '4:3': [2048, 1536], '9:16': [1152, 2048], '16:9': [2048, 1152],
  };
  const size = presets[id] || presets['1:1-1K'];
  const ratioId = id.startsWith('1:1') ? '1:1' : id;
  return { ...current, width: size[0], height: size[1], ratioId };
}

export function buildFaceBatchPlan(state: FaceExpression3DState): FaceExpressionBatchItem[] {
  const expressions = state.batch.expressionPresetIds.length ? state.batch.expressionPresetIds : [state.expression.presetId || 'neutral'];
  const cameras = state.batch.cameraPresetIds.length ? state.batch.cameraPresetIds : [state.camera.framingPreset || 'portrait'];
  const pairs: Array<[string, string]> = [];
  if (state.batch.mode === 'cartesian') {
    for (const expressionId of expressions) for (const cameraId of cameras) pairs.push([expressionId, cameraId]);
  } else {
    const count = Math.max(expressions.length, cameras.length);
    for (let index = 0; index < count; index += 1) {
      pairs.push([expressions[index % expressions.length], cameras[index % cameras.length]]);
    }
  }
  return pairs.slice(0, state.batch.maxItems).map(([expressionPresetId, cameraPresetId], index) => ({
    index,
    expressionPresetId,
    cameraPresetId,
    fileLabel: `${expressionPresetId}-${cameraPresetId}-${String(index + 1).padStart(2, '0')}`,
  }));
}

export function faceExpressionMetadata(state: FaceExpression3DState, imageUrl?: string) {
  const clean = normalizeFaceExpressionState(state);
  return {
    schema: FACE_EXPRESSION_SCHEMA,
    version: FACE_EXPRESSION_VERSION,
    model: clean.model,
    expression: clean.expression,
    pose: clean.pose,
    camera: clean.camera,
    lighting: clean.lighting,
    output: clean.output,
    imageUrl: imageUrl || '',
    createdAt: new Date().toISOString(),
  };
}

export function applyPhotoCalibration(
  state: FaceExpression3DState,
  calibration: FacePhotoCalibration,
  blendshapes?: Partial<Record<FaceChannel, number>>,
): FaceExpression3DState {
  const channels = { ...state.expression.channels };
  if (blendshapes) {
    for (const channel of FACE_CHANNELS) {
      if (blendshapes[channel] == null) continue;
      channels[channel] = clampFaceValue(blendshapes[channel]);
    }
  }
  return normalizeFaceExpressionState({
    ...state,
    model: {
      ...state.model,
      source: 'procedural',
      adapterId: BUILTIN_FACE_ADAPTER_ID,
      adapterVersion: BUILTIN_FACE_ADAPTER_VERSION,
      skinColor: calibration.skinColor,
      hairColor: calibration.hairColor,
      irisColor: calibration.irisColor,
      proportions: {
        faceWidth: calibration.faceWidth,
        faceHeight: calibration.faceHeight,
        jawWidth: calibration.jawWidth,
        eyeSpacing: calibration.eyeSpacing,
        eyeSize: calibration.eyeSize,
        browHeight: calibration.browHeight,
        noseLength: calibration.noseLength,
        noseWidth: calibration.noseWidth,
        mouthWidth: calibration.mouthWidth,
        lipThickness: calibration.lipThickness,
      },
      photoCalibration: calibration,
    },
    expression: { ...state.expression, presetId: blendshapes ? 'photo' : state.expression.presetId, channels },
  });
}
