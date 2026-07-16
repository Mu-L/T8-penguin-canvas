import type { FaceChannelValues, FaceExpressionPreset } from './faceExpression3D';

export const FACE_PRESET_LIBRARY_REFERENCES = {
  arkit: 'https://developer.apple.com/documentation/arkit/arfaceanchor/blendshapes',
  mediapipe: 'https://ai.google.dev/edge/api/mediapipe/python/mp/tasks/vision/drawing_styles/face_landmarker/Blendshapes',
  facs: 'https://www.paulekman.com/facial-action-coding-system/',
  compoundExpressions: 'https://doi.org/10.1073/pnas.1322355111',
} as const;

export type FacePresetLibraryCategory = 'basic' | 'compound' | 'social';
export type FacePresetEvidence = 'FACS-PNAS-2014' | 'ARKit-channel';

export interface FaceExpressionLibraryPreset extends FaceExpressionPreset {
  category: FacePresetLibraryCategory;
  categoryLabel: string;
  description: string;
  intensityId: 'subtle' | 'gentle' | 'standard' | 'strong';
  intensityLabel: string;
  actionUnits: string[];
  evidence: FacePresetEvidence;
}

type Channels = Partial<FaceChannelValues>;
type ActionUnitId = keyof typeof ACTION_UNIT_CHANNELS;

const ACTION_UNIT_CHANNELS = {
  AU1: { browInnerUp: 0.72 },
  AU2: { browOuterUpLeft: 0.68, browOuterUpRight: 0.68 },
  AU4: { browDownLeft: 0.78, browDownRight: 0.78 },
  AU5: { eyeWideLeft: 0.72, eyeWideRight: 0.72 },
  AU6: { cheekSquintLeft: 0.56, cheekSquintRight: 0.56 },
  AU7: { eyeSquintLeft: 0.58, eyeSquintRight: 0.58 },
  AU9: { noseSneerLeft: 0.74, noseSneerRight: 0.74 },
  AU10: { mouthUpperUpLeft: 0.66, mouthUpperUpRight: 0.66 },
  AU12: { mouthSmileLeft: 0.82, mouthSmileRight: 0.82 },
  AU15: { mouthFrownLeft: 0.74, mouthFrownRight: 0.74 },
  AU17: { mouthShrugLower: 0.48, mouthPressLeft: 0.2, mouthPressRight: 0.2 },
  AU20: { mouthStretchLeft: 0.72, mouthStretchRight: 0.72 },
  AU23: { mouthPressLeft: 0.68, mouthPressRight: 0.68 },
  AU24: { mouthClose: 0.8 },
  AU25: { jawOpen: 0.28 },
  AU26: { jawOpen: 0.76 },
} satisfies Record<string, Channels>;

function mergeChannels(...sources: Channels[]): Channels {
  const result: Channels = {};
  for (const source of sources) {
    for (const [channel, value] of Object.entries(source)) {
      const key = channel as keyof FaceChannelValues;
      result[key] = Math.max(result[key] || 0, Number(value) || 0);
    }
  }
  return result;
}

function aus(ids: ActionUnitId[], adjustments: Channels = {}): Channels {
  return mergeChannels(...ids.map((id) => ACTION_UNIT_CHANNELS[id]), adjustments);
}

interface Prototype {
  id: string;
  name: string;
  category: FacePresetLibraryCategory;
  description: string;
  actionUnits: string[];
  evidence: FacePresetEvidence;
  channels: Channels;
}

const PROTOTYPES: Prototype[] = [
  { id: 'happy', name: '快乐', category: 'basic', description: '颊部提起与嘴角上扬', actionUnits: ['AU6', 'AU12'], evidence: 'FACS-PNAS-2014', channels: aus(['AU6', 'AU12']) },
  { id: 'sad', name: '悲伤', category: 'basic', description: '眉部收紧与嘴角下压', actionUnits: ['AU4', 'AU15'], evidence: 'FACS-PNAS-2014', channels: aus(['AU4', 'AU15'], { browInnerUp: 0.32 }) },
  { id: 'fearful', name: '害怕', category: 'basic', description: '内眉上扬、眉部收紧与嘴角横拉', actionUnits: ['AU1', 'AU4', 'AU20', 'AU25'], evidence: 'FACS-PNAS-2014', channels: aus(['AU1', 'AU4', 'AU20', 'AU25'], { eyeWideLeft: 0.44, eyeWideRight: 0.44 }) },
  { id: 'angry', name: '愤怒', category: 'basic', description: '眉毛下压、眼睑收紧与闭唇', actionUnits: ['AU4', 'AU7', 'AU24'], evidence: 'FACS-PNAS-2014', channels: aus(['AU4', 'AU7', 'AU24']) },
  { id: 'surprised', name: '惊讶', category: 'basic', description: '双眉抬起、睁眼与下颌打开', actionUnits: ['AU1', 'AU2', 'AU25', 'AU26'], evidence: 'FACS-PNAS-2014', channels: aus(['AU1', 'AU2', 'AU25', 'AU26'], { eyeWideLeft: 0.58, eyeWideRight: 0.58 }) },
  { id: 'disgusted', name: '厌恶', category: 'basic', description: '皱鼻、上唇提起与下唇推出', actionUnits: ['AU9', 'AU10', 'AU17'], evidence: 'FACS-PNAS-2014', channels: aus(['AU9', 'AU10', 'AU17']) },

  { id: 'happily-surprised', name: '惊喜', category: 'compound', description: '快乐与惊讶的复合表达', actionUnits: ['AU1', 'AU2', 'AU12', 'AU25'], evidence: 'FACS-PNAS-2014', channels: aus(['AU1', 'AU2', 'AU12', 'AU25'], { cheekSquintLeft: 0.28, cheekSquintRight: 0.28 }) },
  { id: 'happily-disgusted', name: '又好笑又嫌弃', category: 'compound', description: '笑意与上唇提起同时出现', actionUnits: ['AU10', 'AU12', 'AU25'], evidence: 'FACS-PNAS-2014', channels: aus(['AU10', 'AU12', 'AU25'], { noseSneerLeft: 0.34, noseSneerRight: 0.34 }) },
  { id: 'sadly-fearful', name: '悲伤害怕', category: 'compound', description: '悲伤眉形与恐惧嘴形结合', actionUnits: ['AU1', 'AU4', 'AU20', 'AU25', 'AU15'], evidence: 'FACS-PNAS-2014', channels: aus(['AU1', 'AU4', 'AU20', 'AU25'], { mouthFrownLeft: 0.32, mouthFrownRight: 0.32 }) },
  { id: 'sadly-angry', name: '悲愤', category: 'compound', description: '眉部压低与嘴角下压', actionUnits: ['AU4', 'AU15', 'AU7', 'AU17'], evidence: 'FACS-PNAS-2014', channels: aus(['AU4', 'AU15'], { eyeSquintLeft: 0.28, eyeSquintRight: 0.28, mouthShrugLower: 0.2 }) },
  { id: 'sadly-surprised', name: '错愕悲伤', category: 'compound', description: '内眉上扬、眉部收紧与下颌打开', actionUnits: ['AU1', 'AU4', 'AU25', 'AU26'], evidence: 'FACS-PNAS-2014', channels: aus(['AU1', 'AU4', 'AU25', 'AU26'], { mouthFrownLeft: 0.28, mouthFrownRight: 0.28 }) },
  { id: 'sadly-disgusted', name: '悲伤厌恶', category: 'compound', description: '眉部收紧与上唇提起', actionUnits: ['AU4', 'AU10', 'AU15'], evidence: 'FACS-PNAS-2014', channels: aus(['AU4', 'AU10'], { mouthFrownLeft: 0.34, mouthFrownRight: 0.34 }) },
  { id: 'fearfully-angry', name: '又怕又怒', category: 'compound', description: '压眉、嘴角横拉与开唇', actionUnits: ['AU4', 'AU20', 'AU25', 'AU7'], evidence: 'FACS-PNAS-2014', channels: aus(['AU4', 'AU20', 'AU25'], { eyeSquintLeft: 0.3, eyeSquintRight: 0.3 }) },
  { id: 'fearfully-surprised', name: '惊恐', category: 'compound', description: '抬眉、睁眼与嘴角横拉', actionUnits: ['AU1', 'AU2', 'AU5', 'AU20', 'AU25', 'AU26'], evidence: 'FACS-PNAS-2014', channels: aus(['AU1', 'AU2', 'AU5', 'AU20', 'AU25'], { jawOpen: 0.48 }) },
  { id: 'fearfully-disgusted', name: '恐惧厌恶', category: 'compound', description: '恐惧眉嘴形叠加上唇提起', actionUnits: ['AU1', 'AU4', 'AU10', 'AU20', 'AU25'], evidence: 'FACS-PNAS-2014', channels: aus(['AU1', 'AU4', 'AU10', 'AU20', 'AU25'], { noseSneerLeft: 0.26, noseSneerRight: 0.26 }) },
  { id: 'angrily-surprised', name: '震怒', category: 'compound', description: '压眉、睁眼与下颌打开', actionUnits: ['AU4', 'AU25', 'AU26', 'AU7'], evidence: 'FACS-PNAS-2014', channels: aus(['AU4', 'AU25', 'AU26'], { eyeSquintLeft: 0.24, eyeSquintRight: 0.24 }) },
  { id: 'angrily-disgusted', name: '愤怒厌恶', category: 'compound', description: '压眉、上唇提起与下唇推出', actionUnits: ['AU4', 'AU10', 'AU17', 'AU7', 'AU9'], evidence: 'FACS-PNAS-2014', channels: aus(['AU4', 'AU10', 'AU17'], { eyeSquintLeft: 0.25, eyeSquintRight: 0.25, noseSneerLeft: 0.3, noseSneerRight: 0.3 }) },
  { id: 'disgustedly-surprised', name: '嫌恶惊讶', category: 'compound', description: '抬眉睁眼与上唇提起', actionUnits: ['AU1', 'AU2', 'AU5', 'AU10', 'AU9'], evidence: 'FACS-PNAS-2014', channels: aus(['AU1', 'AU2', 'AU5', 'AU10'], { noseSneerLeft: 0.28, noseSneerRight: 0.28 }) },
  { id: 'appalled', name: '反感震惊', category: 'compound', description: '以厌恶为主的愤怒复合表情', actionUnits: ['AU4', 'AU10', 'AU9', 'AU17'], evidence: 'FACS-PNAS-2014', channels: aus(['AU4', 'AU10'], { noseSneerLeft: 0.5, noseSneerRight: 0.5, mouthShrugLower: 0.32 }) },
  { id: 'hatred', name: '憎恨', category: 'compound', description: '以愤怒为主的厌恶复合表情', actionUnits: ['AU4', 'AU10', 'AU7', 'AU17'], evidence: 'FACS-PNAS-2014', channels: aus(['AU4', 'AU10'], { eyeSquintLeft: 0.46, eyeSquintRight: 0.46, mouthShrugLower: 0.24 }) },
  { id: 'awed', name: '敬畏', category: 'compound', description: '抬眉睁眼与轻微张口', actionUnits: ['AU1', 'AU2', 'AU5', 'AU25', 'AU20', 'AU26'], evidence: 'FACS-PNAS-2014', channels: aus(['AU1', 'AU2', 'AU5', 'AU25'], { mouthStretchLeft: 0.28, mouthStretchRight: 0.28, jawOpen: 0.42 }) },

  { id: 'polite-smile', name: '礼貌微笑', category: 'social', description: '仅嘴角轻柔上扬', actionUnits: ['AU12'], evidence: 'ARKit-channel', channels: aus(['AU12'], { mouthClose: 0.18 }) },
  { id: 'wink-left', name: '左眨眼', category: 'social', description: '左眼闭合并带轻微笑意', actionUnits: ['eyeBlinkLeft', 'mouthSmileLeft'], evidence: 'ARKit-channel', channels: { eyeBlinkLeft: 0.96, mouthSmileLeft: 0.34, cheekSquintLeft: 0.22 } },
  { id: 'wink-right', name: '右眨眼', category: 'social', description: '右眼闭合并带轻微笑意', actionUnits: ['eyeBlinkRight', 'mouthSmileRight'], evidence: 'ARKit-channel', channels: { eyeBlinkRight: 0.96, mouthSmileRight: 0.34, cheekSquintRight: 0.22 } },
  { id: 'kiss', name: '亲吻', category: 'social', description: '闭唇收拢并向前噘起', actionUnits: ['mouthPucker', 'mouthFunnel'], evidence: 'ARKit-channel', channels: { mouthPucker: 0.88, mouthFunnel: 0.38, mouthClose: 0.24 } },
];

export const FACE_PRESET_LIBRARY_LEVELS = [
  { id: 'subtle', label: '轻微', scale: 0.36 },
  { id: 'gentle', label: '柔和', scale: 0.56 },
  { id: 'standard', label: '标准', scale: 0.78 },
  { id: 'strong', label: '强烈', scale: 1 },
] as const;

export const FACE_PRESET_LIBRARY_CATEGORIES: Array<{ id: 'all' | FacePresetLibraryCategory; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'basic', label: '基础情绪' },
  { id: 'compound', label: '复合情绪' },
  { id: 'social', label: '社交动作' },
];

const CATEGORY_LABELS: Record<FacePresetLibraryCategory, string> = {
  basic: '基础情绪',
  compound: '复合情绪',
  social: '社交动作',
};

function scaledChannels(channels: Channels, scale: number): Channels {
  return Object.fromEntries(Object.entries(channels).map(([key, value]) => [key, Number((Number(value) * scale).toFixed(3))])) as Channels;
}

export const FACE_EXPRESSION_LIBRARY_PRESETS: FaceExpressionLibraryPreset[] = PROTOTYPES.flatMap((prototype) => (
  FACE_PRESET_LIBRARY_LEVELS.map((level) => ({
    id: `library-${prototype.id}-${level.id}`,
    name: `${prototype.name} · ${level.label}`,
    builtin: true,
    category: prototype.category,
    categoryLabel: CATEGORY_LABELS[prototype.category],
    description: prototype.description,
    intensityId: level.id,
    intensityLabel: level.label,
    actionUnits: [...prototype.actionUnits],
    evidence: prototype.evidence,
    channels: scaledChannels(prototype.channels, level.scale),
  }))
));
