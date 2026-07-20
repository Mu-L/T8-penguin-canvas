import React, { memo, useEffect, useMemo, useRef, useState } from 'react';
import type { NodeProps } from '@xyflow/react';
import { Handle, Position, useReactFlow } from '@xyflow/react';
import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision';
import {
  Copy,
  Download,
  FileJson,
  Hand,
  ImagePlus,
  Layers,
  Move,
  PackagePlus,
  PersonStanding,
  Play,
  RotateCcw,
  Shuffle,
  Star,
  Trash2,
  Upload,
  UserMinus,
  UserPlus,
} from 'lucide-react';
import { useRunTrigger } from '../../hooks/useRunTrigger';
import { createCanvasNodeRunRequestId, requestCanvasNodeRun } from '../../utils/canvasRunRequest';
import { useUpdateNodeData } from './useUpdateNodeData';
import { PORT_COLOR } from '../../config/portTypes';
import * as api from '../../services/api';
import { useCanvasStore } from '../../stores/canvas';
import { logBus } from '../../stores/logs';
import { uploadDataUrl, uploadFileBlob } from '../../services/imageOps';
import { placeSingleNode } from '../../utils/nodePlacement';
import { useUpstreamMaterials } from './useUpstreamMaterials';

type Lang = 'en' | 'zh';
type JointKey =
  | 'head'
  | 'neck'
  | 'chest'
  | 'pelvis'
  | 'lShoulder'
  | 'rShoulder'
  | 'lElbow'
  | 'rElbow'
  | 'lWrist'
  | 'rWrist'
  | 'lHip'
  | 'rHip'
  | 'lKnee'
  | 'rKnee'
  | 'lAnkle'
  | 'rAnkle'
  | 'lFoot'
  | 'rFoot';

type PosePoint = { x: number; y: number };
type PosePoints = Record<JointKey, PosePoint>;
type PosePreset = {
  id: string;
  label: string;
  labelEn: string;
  promptEn: string;
  promptZh: string;
  points: PosePoints;
};
type HandShape = 'open' | 'fist' | 'point';
type HandDirection = 'front' | 'side' | 'up' | 'down';
type HandSideControl = {
  shape: HandShape;
  direction: HandDirection;
};
type HandControls = {
  left: HandSideControl;
  right: HandSideControl;
};
type PoseBackup = {
  schema: string;
  version: number;
  pointVersion: number;
  hasPeople?: boolean;
  presetId: string;
  viewId: string;
  shotId: string;
  intensityId: string;
  language: Lang;
  custom: string;
  points: PosePoints;
  people?: PosePoints[];
  handControls?: HandControls;
  canvasRatioId?: PoseCanvasRatioId;
  canvasCustomWidth?: number;
  canvasCustomHeight?: number;
  prompt?: string;
  name?: string;
  createdAt?: number;
};
type PoseFavorite = PoseBackup & {
  id: string;
  name: string;
  createdAt: number;
};
type PoseBatchMode = 'next' | 'random' | 'current';
type PoseRenderMode = 'lineart' | 'openpose' | 'coco';
type PoseMasterRunMode = 'single' | 'batch' | 'keyframes';
type PoseDragMode = 'joint' | 'body';
type PoseCanvasRatioId = 'default' | '1:1' | '4:3' | '3:4' | '16:9' | '9:16' | '3:2' | '2:3' | 'custom';
type PoseCanvasBounds = {
  id: PoseCanvasRatioId;
  width: number;
  height: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  ratio: number;
};
type PoseDragState =
  | { mode: 'joint'; key: JointKey }
  | { mode: 'body'; start: PosePoint; origin: PosePoints; bounds: PoseCanvasBounds }
  | { mode: 'scale'; center: PosePoint; startDistance: number; origin: PosePoints; bounds: PoseCanvasBounds }
  | { mode: 'rotate'; center: PosePoint; startAngle: number; origin: PosePoints; bounds: PoseCanvasBounds };

const LEGACY_VIEW_W = 420;
const VIEW_W = 620;
const VIEW_H = 520;
const VIEW_X_OFFSET = (VIEW_W - LEGACY_VIEW_W) / 2;
const POSE_OUTPUT_W = 1240;
const POSE_OUTPUT_H = 1040;
const POSE_CANVAS_PANEL_W = 676;
const POSE_CANVAS_PANEL_H = 560;
const POSE_CANVAS_PADDING = 8;
const POSE_CANVAS_FRAME_PADDING = 18;
const DEFAULT_CANVAS_BOUNDS: PoseCanvasBounds = {
  id: 'default',
  width: VIEW_W,
  height: VIEW_H,
  minX: 0,
  minY: 0,
  maxX: VIEW_W,
  maxY: VIEW_H,
  ratio: VIEW_W / VIEW_H,
};
const POSE_SCHEMA = 't8-pose-master';
const POSE_LIBRARY_SCHEMA = 't8-pose-master-library';
const KEYPOINT_SCHEMA = 't8-pose-master-keypoints';
const POSE_POINT_VERSION = 4;
const FOOT_MIN_DISTANCE = 12;
const FOOT_MAX_DISTANCE = 34;
const MAX_POSE_FAVORITES = 16;
const MAX_POSE_PEOPLE = 5;
const MEDIAPIPE_WASM_BASE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm';
const MEDIAPIPE_POSE_MODEL =
  'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task';

const DEFAULT_HAND_CONTROLS: HandControls = {
  left: { shape: 'open', direction: 'front' },
  right: { shape: 'open', direction: 'front' },
};

const HAND_SHAPE_OPTIONS: Array<{ id: HandShape; zh: string; en: string }> = [
  { id: 'open', zh: '张开', en: 'open palm' },
  { id: 'fist', zh: '握拳', en: 'closed fist' },
  { id: 'point', zh: '指向', en: 'pointing hand' },
];

const HAND_DIRECTION_OPTIONS: Array<{ id: HandDirection; zh: string; en: string }> = [
  { id: 'front', zh: '掌心向前', en: 'palm facing camera' },
  { id: 'side', zh: '侧掌', en: 'side-facing palm' },
  { id: 'up', zh: '掌心向上', en: 'palm facing upward' },
  { id: 'down', zh: '掌心向下', en: 'palm facing downward' },
];

const LEGACY_DEFAULT_POINTS: PosePoints = {
  head: { x: 160, y: 60 },
  neck: { x: 160, y: 105 },
  chest: { x: 160, y: 160 },
  pelvis: { x: 160, y: 238 },
  lShoulder: { x: 106, y: 122 },
  rShoulder: { x: 214, y: 122 },
  lElbow: { x: 82, y: 190 },
  rElbow: { x: 238, y: 190 },
  lWrist: { x: 74, y: 260 },
  rWrist: { x: 246, y: 260 },
  lHip: { x: 126, y: 242 },
  rHip: { x: 194, y: 242 },
  lKnee: { x: 116, y: 326 },
  rKnee: { x: 204, y: 326 },
  lAnkle: { x: 110, y: 400 },
  rAnkle: { x: 210, y: 400 },
  lFoot: { x: 92, y: 416 },
  rFoot: { x: 228, y: 416 },
};

const DEFAULT_POINTS: PosePoints = {
  head: { x: 210, y: 52 },
  neck: { x: 210, y: 102 },
  chest: { x: 210, y: 172 },
  pelvis: { x: 210, y: 278 },
  lShoulder: { x: 158, y: 132 },
  rShoulder: { x: 262, y: 132 },
  lElbow: { x: 138, y: 226 },
  rElbow: { x: 282, y: 226 },
  lWrist: { x: 134, y: 318 },
  rWrist: { x: 286, y: 318 },
  lHip: { x: 184, y: 282 },
  rHip: { x: 236, y: 282 },
  lKnee: { x: 174, y: 400 },
  rKnee: { x: 246, y: 400 },
  lAnkle: { x: 172, y: 490 },
  rAnkle: { x: 248, y: 490 },
  lFoot: { x: 156, y: 508 },
  rFoot: { x: 264, y: 508 },
};

const MIRROR_PAIRS: [JointKey, JointKey][] = [
  ['lShoulder', 'rShoulder'],
  ['lElbow', 'rElbow'],
  ['lWrist', 'rWrist'],
  ['lHip', 'rHip'],
  ['lKnee', 'rKnee'],
  ['lAnkle', 'rAnkle'],
  ['lFoot', 'rFoot'],
];

function clonePoints(points: PosePoints): PosePoints {
  return Object.fromEntries(
    (Object.keys(DEFAULT_POINTS) as JointKey[]).map((key) => [key, { ...points[key] }]),
  ) as PosePoints;
}

function makePose(delta: Partial<Record<JointKey, PosePoint>>): PosePoints {
  return shiftPosePoints(constrainFootPoints({
    ...clonePoints(DEFAULT_POINTS),
    ...Object.fromEntries(Object.entries(delta).map(([key, value]) => [key, { ...value }])),
  } as PosePoints), VIEW_X_OFFSET);
}

function posePreset(
  id: string,
  label: string,
  labelEn: string,
  delta: Partial<Record<JointKey, PosePoint>>,
  promptEn?: string,
  promptZh?: string,
): PosePreset {
  return {
    id,
    label,
    labelEn,
    promptEn: promptEn || `${labelEn}, clean full-body pose reference, clear anatomy line art`,
    promptZh: promptZh || `${label}，清晰全身姿态参考，人体线稿构图`,
    points: makePose(delta),
  };
}

const CORE_POSE_PRESETS: PosePreset[] = [
  posePreset(
    'standing',
    '自然站立',
    'Neutral standing',
    {},
    'neutral full-body standing pose, relaxed shoulders, balanced weight, clear anatomy pose reference',
    '自然全身站立姿势，肩膀放松，重心平衡，清晰人体姿态参考',
  ),
  posePreset('attention', '立正', 'Standing at attention', {
    lShoulder: { x: 160, y: 132 },
    rShoulder: { x: 260, y: 132 },
    lWrist: { x: 158, y: 320 },
    rWrist: { x: 262, y: 320 },
    lAnkle: { x: 190, y: 490 },
    rAnkle: { x: 230, y: 490 },
  }),
  posePreset('contrapposto', '重心侧站', 'Contrapposto stance', {
    head: { x: 218, y: 52 },
    neck: { x: 214, y: 102 },
    chest: { x: 206, y: 170 },
    pelvis: { x: 222, y: 278 },
    lHip: { x: 196, y: 282 },
    rHip: { x: 248, y: 282 },
    lKnee: { x: 174, y: 398 },
    rKnee: { x: 256, y: 404 },
  }),
  posePreset('hands-on-hips', '双手叉腰', 'Hands on hips', {
    lElbow: { x: 128, y: 220 },
    rElbow: { x: 292, y: 220 },
    lWrist: { x: 182, y: 274 },
    rWrist: { x: 238, y: 274 },
  }),
  posePreset('arms-crossed', '双臂抱胸', 'Arms crossed', {
    lElbow: { x: 162, y: 206 },
    rElbow: { x: 258, y: 206 },
    lWrist: { x: 252, y: 190 },
    rWrist: { x: 168, y: 190 },
  }),
  posePreset('hands-behind-back', '背手站立', 'Hands behind back', {
    lElbow: { x: 142, y: 230 },
    rElbow: { x: 278, y: 230 },
    lWrist: { x: 190, y: 286 },
    rWrist: { x: 230, y: 286 },
  }),
  posePreset('arms-raised', '双手上举', 'Arms raised', {
    lElbow: { x: 142, y: 72 },
    rElbow: { x: 278, y: 72 },
    lWrist: { x: 126, y: 26 },
    rWrist: { x: 294, y: 26 },
  }, 'full-body pose with both arms raised overhead, open chest, energetic upward gesture', '双手高举过头的全身姿势，胸口打开，向上充满能量的动作'),
  posePreset('one-arm-up', '单手上举', 'One arm raised', {
    lElbow: { x: 144, y: 86 },
    lWrist: { x: 128, y: 30 },
    rElbow: { x: 294, y: 230 },
    rWrist: { x: 308, y: 318 },
  }),
  posePreset('waving', '挥手', 'Waving hand', {
    lElbow: { x: 138, y: 104 },
    lWrist: { x: 106, y: 76 },
    rElbow: { x: 286, y: 230 },
    rWrist: { x: 294, y: 318 },
  }),
  posePreset('salute', '敬礼', 'Salute pose', {
    lElbow: { x: 154, y: 150 },
    lWrist: { x: 190, y: 76 },
    rElbow: { x: 286, y: 228 },
    rWrist: { x: 288, y: 316 },
  }),
  posePreset('pointing-forward', '前指', 'Pointing forward', {
    lElbow: { x: 140, y: 204 },
    lWrist: { x: 92, y: 174 },
    rElbow: { x: 292, y: 218 },
    rWrist: { x: 344, y: 184 },
  }),
  posePreset('presenting', '展示介绍', 'Presenting gesture', {
    lElbow: { x: 132, y: 214 },
    lWrist: { x: 78, y: 230 },
    rElbow: { x: 288, y: 214 },
    rWrist: { x: 342, y: 230 },
  }),
  posePreset('thinking', '托腮思考', 'Thinking hand to chin', {
    lElbow: { x: 150, y: 208 },
    lWrist: { x: 196, y: 104 },
    rElbow: { x: 292, y: 230 },
    rWrist: { x: 292, y: 318 },
  }),
  posePreset('shy-inward', '害羞内收', 'Shy inward pose', {
    head: { x: 205, y: 56 },
    chest: { x: 210, y: 178 },
    lElbow: { x: 178, y: 216 },
    rElbow: { x: 242, y: 216 },
    lWrist: { x: 196, y: 250 },
    rWrist: { x: 224, y: 250 },
    lKnee: { x: 192, y: 402 },
    rKnee: { x: 228, y: 402 },
  }),
  posePreset('stretch-side', '侧身伸展', 'Side stretch', {
    chest: { x: 200, y: 166 },
    pelvis: { x: 222, y: 282 },
    lElbow: { x: 118, y: 80 },
    lWrist: { x: 76, y: 36 },
    rElbow: { x: 292, y: 240 },
    rWrist: { x: 320, y: 318 },
  }),
  posePreset('walking', '自然行走', 'Natural walking', {
    pelvis: { x: 214, y: 278 },
    lElbow: { x: 146, y: 214 },
    lWrist: { x: 122, y: 294 },
    rElbow: { x: 280, y: 214 },
    rWrist: { x: 306, y: 294 },
    lKnee: { x: 150, y: 396 },
    lAnkle: { x: 122, y: 486 },
    rKnee: { x: 270, y: 396 },
    rAnkle: { x: 286, y: 486 },
  }),
  posePreset('casual-step', '跨步停顿', 'Casual step', {
    chest: { x: 214, y: 172 },
    pelvis: { x: 204, y: 278 },
    lKnee: { x: 154, y: 400 },
    lAnkle: { x: 122, y: 488 },
    rKnee: { x: 260, y: 390 },
    rAnkle: { x: 300, y: 474 },
  }),
  posePreset('running', '奔跑', 'Running pose', {
    head: { x: 230, y: 52 },
    neck: { x: 225, y: 104 },
    chest: { x: 220, y: 172 },
    pelvis: { x: 202, y: 276 },
    lShoulder: { x: 168, y: 134 },
    rShoulder: { x: 276, y: 134 },
    lElbow: { x: 154, y: 196 },
    lWrist: { x: 118, y: 172 },
    rElbow: { x: 284, y: 244 },
    rWrist: { x: 314, y: 320 },
    lHip: { x: 178, y: 282 },
    rHip: { x: 228, y: 282 },
    lKnee: { x: 145, y: 382 },
    lAnkle: { x: 114, y: 468 },
    lFoot: { x: 92, y: 486 },
    rKnee: { x: 286, y: 385 },
    rAnkle: { x: 316, y: 472 },
    rFoot: { x: 338, y: 492 },
  }, 'dynamic running pose, forward lean, one arm forward and one arm back, legs in stride', '动态奔跑姿势，身体前倾，一手向前一手向后，双腿跨步'),
  posePreset('sprint-start', '起跑准备', 'Sprint start', {
    head: { x: 242, y: 96 },
    neck: { x: 228, y: 136 },
    chest: { x: 208, y: 190 },
    pelvis: { x: 182, y: 290 },
    lShoulder: { x: 164, y: 160 },
    rShoulder: { x: 260, y: 166 },
    lWrist: { x: 110, y: 290 },
    rWrist: { x: 306, y: 300 },
    lKnee: { x: 130, y: 384 },
    lAnkle: { x: 92, y: 470 },
    rKnee: { x: 278, y: 378 },
    rAnkle: { x: 338, y: 442 },
  }),
  posePreset('jump', '跳跃', 'Jumping pose', {
    pelvis: { x: 210, y: 250 },
    lElbow: { x: 110, y: 148 },
    lWrist: { x: 70, y: 116 },
    rElbow: { x: 310, y: 148 },
    rWrist: { x: 350, y: 116 },
    lHip: { x: 185, y: 256 },
    rHip: { x: 236, y: 256 },
    lKnee: { x: 166, y: 338 },
    lAnkle: { x: 132, y: 410 },
    lFoot: { x: 110, y: 422 },
    rKnee: { x: 264, y: 338 },
    rAnkle: { x: 296, y: 410 },
    rFoot: { x: 318, y: 422 },
  }, 'jumping pose in midair, lifted knees, arms open for balance, lively motion', '半空跳跃姿势，膝盖抬起，双臂打开保持平衡，动作轻快'),
  posePreset('landing', '落地缓冲', 'Landing crouch', {
    head: { x: 210, y: 82 },
    neck: { x: 210, y: 126 },
    chest: { x: 210, y: 196 },
    pelvis: { x: 210, y: 316 },
    lElbow: { x: 122, y: 226 },
    lWrist: { x: 82, y: 282 },
    rElbow: { x: 298, y: 226 },
    rWrist: { x: 338, y: 282 },
    lKnee: { x: 156, y: 404 },
    rKnee: { x: 264, y: 404 },
    lAnkle: { x: 128, y: 488 },
    rAnkle: { x: 292, y: 488 },
  }),
  posePreset('crouch', '低姿蹲伏', 'Low crouch', {
    head: { x: 210, y: 98 },
    neck: { x: 210, y: 142 },
    chest: { x: 210, y: 210 },
    pelvis: { x: 210, y: 330 },
    lElbow: { x: 140, y: 256 },
    lWrist: { x: 116, y: 324 },
    rElbow: { x: 280, y: 256 },
    rWrist: { x: 304, y: 324 },
    lKnee: { x: 146, y: 408 },
    rKnee: { x: 274, y: 408 },
    lAnkle: { x: 112, y: 486 },
    rAnkle: { x: 308, y: 486 },
  }),
  posePreset('squat', '深蹲', 'Deep squat', {
    pelvis: { x: 210, y: 336 },
    lKnee: { x: 144, y: 392 },
    rKnee: { x: 276, y: 392 },
    lAnkle: { x: 140, y: 488 },
    rAnkle: { x: 280, y: 488 },
    lWrist: { x: 156, y: 318 },
    rWrist: { x: 264, y: 318 },
  }),
  posePreset('kneeling', '单膝跪地', 'One-knee kneel', {
    pelvis: { x: 210, y: 284 },
    lKnee: { x: 166, y: 405 },
    lAnkle: { x: 120, y: 488 },
    lFoot: { x: 98, y: 504 },
    rKnee: { x: 285, y: 354 },
    rAnkle: { x: 288, y: 476 },
    rFoot: { x: 314, y: 490 },
  }, 'one-knee kneeling pose, one leg folded under the body, one knee raised, composed posture', '单膝跪地姿势，一条腿收在身下，一侧膝盖抬起，姿态沉稳'),
  posePreset('prayer-kneel', '跪坐合掌', 'Kneeling prayer', {
    pelvis: { x: 210, y: 312 },
    lKnee: { x: 168, y: 420 },
    rKnee: { x: 252, y: 420 },
    lAnkle: { x: 146, y: 488 },
    rAnkle: { x: 274, y: 488 },
    lElbow: { x: 178, y: 214 },
    rElbow: { x: 242, y: 214 },
    lWrist: { x: 200, y: 202 },
    rWrist: { x: 220, y: 202 },
  }),
  posePreset('lunge', '弓步', 'Forward lunge', {
    pelvis: { x: 210, y: 292 },
    lKnee: { x: 134, y: 380 },
    lAnkle: { x: 82, y: 478 },
    rKnee: { x: 282, y: 410 },
    rAnkle: { x: 332, y: 486 },
    lElbow: { x: 132, y: 182 },
    lWrist: { x: 86, y: 156 },
    rElbow: { x: 292, y: 236 },
    rWrist: { x: 330, y: 300 },
  }),
  posePreset('high-kick', '高踢腿', 'High kick', {
    pelvis: { x: 206, y: 278 },
    lHip: { x: 184, y: 282 },
    lKnee: { x: 130, y: 214 },
    lAnkle: { x: 78, y: 124 },
    lFoot: { x: 56, y: 104 },
    rKnee: { x: 252, y: 400 },
    rAnkle: { x: 252, y: 490 },
  }),
  posePreset('side-kick', '侧踢', 'Side kick', {
    pelvis: { x: 198, y: 282 },
    lHip: { x: 178, y: 282 },
    lKnee: { x: 118, y: 304 },
    lAnkle: { x: 48, y: 312 },
    lFoot: { x: 24, y: 312 },
    rKnee: { x: 246, y: 402 },
    rAnkle: { x: 248, y: 490 },
  }),
  posePreset('punch', '出拳', 'Punching pose', {
    chest: { x: 222, y: 172 },
    lElbow: { x: 150, y: 188 },
    lWrist: { x: 96, y: 176 },
    rElbow: { x: 304, y: 170 },
    rWrist: { x: 382, y: 162 },
    lKnee: { x: 162, y: 398 },
    rKnee: { x: 270, y: 394 },
  }),
  posePreset('combat', '战斗架势', 'Combat stance', {
    lElbow: { x: 142, y: 164 },
    lWrist: { x: 186, y: 140 },
    rElbow: { x: 284, y: 178 },
    rWrist: { x: 324, y: 150 },
    lKnee: { x: 150, y: 390 },
    rKnee: { x: 278, y: 386 },
    lAnkle: { x: 120, y: 486 },
    lFoot: { x: 98, y: 504 },
    rAnkle: { x: 310, y: 478 },
    rFoot: { x: 332, y: 494 },
  }, 'martial arts combat stance, bent knees, guarded arms, ready to strike, strong silhouette', '武术战斗架势，膝盖弯曲，双臂防御，准备出击，轮廓有力量'),
  posePreset('sword-stance', '持剑架势', 'Sword stance', {
    lElbow: { x: 164, y: 158 },
    lWrist: { x: 198, y: 146 },
    rElbow: { x: 260, y: 160 },
    rWrist: { x: 222, y: 146 },
    lKnee: { x: 150, y: 392 },
    lAnkle: { x: 122, y: 486 },
    rKnee: { x: 270, y: 392 },
    rAnkle: { x: 306, y: 482 },
  }),
  posePreset('archer', '拉弓', 'Archer pose', {
    chest: { x: 218, y: 170 },
    lElbow: { x: 110, y: 170 },
    lWrist: { x: 62, y: 166 },
    rElbow: { x: 292, y: 164 },
    rWrist: { x: 214, y: 152 },
    lKnee: { x: 150, y: 402 },
    rKnee: { x: 278, y: 394 },
  }),
  posePreset('dance-idol', '偶像舞步', 'Idol dance pose', {
    head: { x: 206, y: 50 },
    chest: { x: 214, y: 170 },
    pelvis: { x: 202, y: 276 },
    lElbow: { x: 126, y: 136 },
    lWrist: { x: 90, y: 98 },
    rElbow: { x: 286, y: 206 },
    rWrist: { x: 328, y: 184 },
    lKnee: { x: 184, y: 400 },
    rKnee: { x: 260, y: 386 },
  }),
  posePreset('ballet', '芭蕾伸展', 'Ballet arabesque', {
    chest: { x: 206, y: 168 },
    pelvis: { x: 210, y: 278 },
    lElbow: { x: 122, y: 126 },
    lWrist: { x: 76, y: 110 },
    rElbow: { x: 298, y: 126 },
    rWrist: { x: 344, y: 110 },
    lKnee: { x: 178, y: 402 },
    lAnkle: { x: 172, y: 490 },
    rKnee: { x: 306, y: 330 },
    rAnkle: { x: 386, y: 330 },
    rFoot: { x: 412, y: 330 },
  }),
  posePreset('spin-dance', '旋转舞姿', 'Spinning dance', {
    head: { x: 218, y: 50 },
    chest: { x: 214, y: 168 },
    pelvis: { x: 206, y: 276 },
    lElbow: { x: 104, y: 168 },
    lWrist: { x: 42, y: 172 },
    rElbow: { x: 316, y: 168 },
    rWrist: { x: 378, y: 172 },
    lKnee: { x: 188, y: 398 },
    rKnee: { x: 236, y: 398 },
  }),
  posePreset('microphone', '手持麦克风', 'Holding microphone', {
    lElbow: { x: 154, y: 158 },
    lWrist: { x: 194, y: 92 },
    rElbow: { x: 290, y: 230 },
    rWrist: { x: 306, y: 318 },
  }),
  posePreset('guitar', '抱吉他', 'Holding guitar', {
    lElbow: { x: 142, y: 210 },
    lWrist: { x: 112, y: 226 },
    rElbow: { x: 280, y: 210 },
    rWrist: { x: 250, y: 226 },
    chest: { x: 212, y: 174 },
  }),
  posePreset('sitting', '坐姿', 'Sitting pose', {
    pelvis: { x: 210, y: 286 },
    lKnee: { x: 132, y: 360 },
    rKnee: { x: 288, y: 360 },
    lAnkle: { x: 116, y: 428 },
    rAnkle: { x: 304, y: 428 },
    lFoot: { x: 94, y: 438 },
    rFoot: { x: 326, y: 438 },
    lWrist: { x: 160, y: 286 },
    rWrist: { x: 260, y: 286 },
  }, 'seated pose, torso upright, knees bent forward, relaxed hands near the body', '坐姿，躯干直立，膝盖向前弯曲，双手自然靠近身体'),
  posePreset('cross-legged', '盘腿坐', 'Cross-legged sitting', {
    head: { x: 210, y: 76 },
    neck: { x: 210, y: 124 },
    chest: { x: 210, y: 194 },
    pelvis: { x: 210, y: 316 },
    lKnee: { x: 130, y: 410 },
    rKnee: { x: 290, y: 410 },
    lAnkle: { x: 250, y: 446 },
    rAnkle: { x: 170, y: 446 },
    lWrist: { x: 156, y: 310 },
    rWrist: { x: 264, y: 310 },
  }),
  posePreset('chair-lean', '椅背倚靠', 'Leaning in chair', {
    head: { x: 204, y: 70 },
    chest: { x: 198, y: 186 },
    pelvis: { x: 224, y: 304 },
    lElbow: { x: 120, y: 234 },
    lWrist: { x: 86, y: 272 },
    rElbow: { x: 300, y: 232 },
    rWrist: { x: 338, y: 270 },
    lKnee: { x: 150, y: 370 },
    rKnee: { x: 298, y: 366 },
    lAnkle: { x: 130, y: 452 },
    rAnkle: { x: 320, y: 450 },
  }),
  posePreset('reclining', '斜躺', 'Reclining pose', {
    head: { x: 136, y: 142 },
    neck: { x: 164, y: 172 },
    chest: { x: 210, y: 210 },
    pelvis: { x: 265, y: 272 },
    lShoulder: { x: 146, y: 195 },
    rShoulder: { x: 250, y: 195 },
    lElbow: { x: 108, y: 250 },
    lWrist: { x: 82, y: 315 },
    rElbow: { x: 296, y: 220 },
    rWrist: { x: 340, y: 246 },
    lHip: { x: 238, y: 292 },
    rHip: { x: 290, y: 292 },
    lKnee: { x: 160, y: 360 },
    rKnee: { x: 342, y: 360 },
    lAnkle: { x: 95, y: 405 },
    lFoot: { x: 74, y: 416 },
    rAnkle: { x: 386, y: 402 },
    rFoot: { x: 410, y: 414 },
  }, 'reclining pose, diagonal body line, one arm supporting the body, relaxed legs', '斜躺姿势，身体形成对角线，一只手支撑身体，双腿放松'),
  posePreset('side-lying', '侧卧', 'Side lying pose', {
    head: { x: 116, y: 206 },
    neck: { x: 148, y: 220 },
    chest: { x: 202, y: 246 },
    pelvis: { x: 282, y: 284 },
    lShoulder: { x: 162, y: 236 },
    rShoulder: { x: 238, y: 250 },
    lElbow: { x: 118, y: 288 },
    lWrist: { x: 92, y: 330 },
    rElbow: { x: 280, y: 260 },
    rWrist: { x: 336, y: 276 },
    lKnee: { x: 250, y: 348 },
    rKnee: { x: 354, y: 330 },
    lAnkle: { x: 190, y: 396 },
    rAnkle: { x: 410, y: 370 },
  }),
  posePreset('yoga-tree', '瑜伽树式', 'Yoga tree pose', {
    lElbow: { x: 174, y: 136 },
    rElbow: { x: 246, y: 136 },
    lWrist: { x: 202, y: 88 },
    rWrist: { x: 218, y: 88 },
    lKnee: { x: 176, y: 404 },
    lAnkle: { x: 172, y: 490 },
    rKnee: { x: 286, y: 332 },
    rAnkle: { x: 202, y: 398 },
  }),
  posePreset('yoga-warrior', '瑜伽战士', 'Yoga warrior pose', {
    lElbow: { x: 96, y: 168 },
    lWrist: { x: 36, y: 168 },
    rElbow: { x: 324, y: 168 },
    rWrist: { x: 384, y: 168 },
    pelvis: { x: 210, y: 286 },
    lKnee: { x: 136, y: 388 },
    lAnkle: { x: 82, y: 486 },
    rKnee: { x: 306, y: 396 },
    rAnkle: { x: 360, y: 486 },
  }),
  posePreset('crawling', '爬行动作', 'Crawling pose', {
    head: { x: 266, y: 156 },
    neck: { x: 246, y: 184 },
    chest: { x: 210, y: 226 },
    pelvis: { x: 166, y: 286 },
    lElbow: { x: 136, y: 286 },
    lWrist: { x: 104, y: 354 },
    rElbow: { x: 272, y: 268 },
    rWrist: { x: 322, y: 330 },
    lKnee: { x: 118, y: 362 },
    lAnkle: { x: 82, y: 442 },
    rKnee: { x: 246, y: 370 },
    rAnkle: { x: 282, y: 456 },
  }),
  posePreset('reaching-forward', '向前伸手', 'Reaching forward', {
    head: { x: 222, y: 60 },
    chest: { x: 218, y: 174 },
    lElbow: { x: 134, y: 188 },
    lWrist: { x: 72, y: 176 },
    rElbow: { x: 294, y: 186 },
    rWrist: { x: 360, y: 174 },
  }),
  posePreset('holding-bag', '拎包站立', 'Holding bag', {
    lElbow: { x: 142, y: 232 },
    lWrist: { x: 132, y: 348 },
    rElbow: { x: 292, y: 216 },
    rWrist: { x: 328, y: 176 },
  }),
  posePreset('camera-pose', '举相机', 'Holding camera', {
    lElbow: { x: 166, y: 150 },
    rElbow: { x: 254, y: 150 },
    lWrist: { x: 192, y: 104 },
    rWrist: { x: 228, y: 104 },
  }),
  posePreset('reading-book', '捧书阅读', 'Reading book', {
    lElbow: { x: 160, y: 214 },
    rElbow: { x: 260, y: 214 },
    lWrist: { x: 186, y: 236 },
    rWrist: { x: 234, y: 236 },
    head: { x: 208, y: 60 },
  }),
  posePreset('hug-self', '抱住自己', 'Self hug', {
    lElbow: { x: 166, y: 206 },
    rElbow: { x: 254, y: 206 },
    lWrist: { x: 252, y: 214 },
    rWrist: { x: 168, y: 214 },
    chest: { x: 210, y: 178 },
  }),
  posePreset('push-wall', '推墙', 'Pushing wall', {
    chest: { x: 224, y: 176 },
    pelvis: { x: 194, y: 282 },
    lElbow: { x: 298, y: 170 },
    lWrist: { x: 370, y: 166 },
    rElbow: { x: 304, y: 218 },
    rWrist: { x: 378, y: 224 },
    lKnee: { x: 154, y: 400 },
    rKnee: { x: 262, y: 396 },
  }),
  posePreset('pull-rope', '拉拽', 'Pulling rope', {
    chest: { x: 196, y: 172 },
    pelvis: { x: 222, y: 282 },
    lElbow: { x: 132, y: 176 },
    lWrist: { x: 70, y: 150 },
    rElbow: { x: 242, y: 202 },
    rWrist: { x: 154, y: 180 },
    lKnee: { x: 174, y: 398 },
    rKnee: { x: 284, y: 394 },
  }),
  posePreset('falling-back', '向后跌落', 'Falling backward', {
    head: { x: 176, y: 86 },
    neck: { x: 190, y: 126 },
    chest: { x: 220, y: 196 },
    pelvis: { x: 248, y: 304 },
    lElbow: { x: 112, y: 190 },
    lWrist: { x: 54, y: 150 },
    rElbow: { x: 328, y: 190 },
    rWrist: { x: 386, y: 150 },
    lKnee: { x: 170, y: 398 },
    rKnee: { x: 300, y: 390 },
  }),
  posePreset('falling-forward', '向前扑倒', 'Falling forward', {
    head: { x: 248, y: 100 },
    neck: { x: 230, y: 136 },
    chest: { x: 210, y: 214 },
    pelvis: { x: 190, y: 318 },
    lElbow: { x: 126, y: 248 },
    lWrist: { x: 86, y: 316 },
    rElbow: { x: 300, y: 250 },
    rWrist: { x: 340, y: 318 },
    lKnee: { x: 146, y: 420 },
    rKnee: { x: 286, y: 420 },
  }),
  posePreset('look-back', '回头看', 'Looking back', {
    head: { x: 188, y: 54 },
    neck: { x: 206, y: 104 },
    chest: { x: 216, y: 172 },
    pelvis: { x: 204, y: 278 },
    lElbow: { x: 136, y: 232 },
    rElbow: { x: 292, y: 214 },
  }),
  posePreset('over-shoulder', '越肩回眸', 'Over shoulder glance', {
    head: { x: 176, y: 58 },
    neck: { x: 202, y: 104 },
    chest: { x: 226, y: 174 },
    pelvis: { x: 214, y: 280 },
    lShoulder: { x: 174, y: 132 },
    rShoulder: { x: 278, y: 132 },
    lWrist: { x: 148, y: 310 },
    rWrist: { x: 300, y: 300 },
  }),
  posePreset('hair-flip', '撩发', 'Hair flip pose', {
    head: { x: 214, y: 50 },
    lElbow: { x: 146, y: 124 },
    lWrist: { x: 188, y: 54 },
    rElbow: { x: 292, y: 230 },
    rWrist: { x: 308, y: 318 },
  }),
  posePreset('hand-heart', '比心', 'Hand heart', {
    lElbow: { x: 172, y: 164 },
    rElbow: { x: 248, y: 164 },
    lWrist: { x: 198, y: 132 },
    rWrist: { x: 222, y: 132 },
  }),
  posePreset('peace-sign', '胜利手势', 'Peace sign pose', {
    lElbow: { x: 150, y: 134 },
    lWrist: { x: 184, y: 64 },
    rElbow: { x: 290, y: 228 },
    rWrist: { x: 304, y: 318 },
  }),
  posePreset('hands-together', '双手合十', 'Hands together', {
    lElbow: { x: 172, y: 196 },
    rElbow: { x: 248, y: 196 },
    lWrist: { x: 202, y: 164 },
    rWrist: { x: 218, y: 164 },
  }),
  posePreset('bowing', '鞠躬', 'Bowing pose', {
    head: { x: 230, y: 120 },
    neck: { x: 218, y: 154 },
    chest: { x: 210, y: 220 },
    pelvis: { x: 202, y: 306 },
    lWrist: { x: 150, y: 340 },
    rWrist: { x: 270, y: 340 },
    lKnee: { x: 178, y: 410 },
    rKnee: { x: 242, y: 410 },
  }),
  posePreset('t-pose', 'T字展开', 'T-pose arms out', {
    lElbow: { x: 104, y: 132 },
    lWrist: { x: 32, y: 132 },
    rElbow: { x: 316, y: 132 },
    rWrist: { x: 388, y: 132 },
  }),
  posePreset('a-pose', 'A字展开', 'A-pose arms down', {
    lElbow: { x: 120, y: 204 },
    lWrist: { x: 76, y: 286 },
    rElbow: { x: 300, y: 204 },
    rWrist: { x: 344, y: 286 },
  }),
  posePreset('star-jump', '大字跳跃', 'Star jump', {
    pelvis: { x: 210, y: 250 },
    lElbow: { x: 100, y: 116 },
    lWrist: { x: 44, y: 78 },
    rElbow: { x: 320, y: 116 },
    rWrist: { x: 376, y: 78 },
    lKnee: { x: 140, y: 348 },
    lAnkle: { x: 82, y: 420 },
    rKnee: { x: 280, y: 348 },
    rAnkle: { x: 338, y: 420 },
  }),
  posePreset('boxing-guard', '拳击防守', 'Boxing guard', {
    lElbow: { x: 168, y: 172 },
    lWrist: { x: 188, y: 108 },
    rElbow: { x: 252, y: 172 },
    rWrist: { x: 232, y: 108 },
    lKnee: { x: 156, y: 392 },
    rKnee: { x: 270, y: 388 },
  }),
  posePreset('tiptoe', '踮脚站立', 'Standing on tiptoe', {
    head: { x: 210, y: 44 },
    neck: { x: 210, y: 96 },
    chest: { x: 210, y: 166 },
    pelvis: { x: 210, y: 272 },
    lAnkle: { x: 176, y: 500 },
    rAnkle: { x: 244, y: 500 },
    lFoot: { x: 166, y: 512 },
    rFoot: { x: 254, y: 512 },
    lWrist: { x: 132, y: 306 },
    rWrist: { x: 288, y: 306 },
  }),
  posePreset('leaning-wall', '倚墙站立', 'Leaning against wall', {
    head: { x: 236, y: 58 },
    neck: { x: 226, y: 106 },
    chest: { x: 214, y: 176 },
    pelvis: { x: 194, y: 284 },
    lShoulder: { x: 172, y: 136 },
    rShoulder: { x: 278, y: 132 },
    lElbow: { x: 132, y: 226 },
    lWrist: { x: 108, y: 310 },
    rElbow: { x: 310, y: 206 },
    rWrist: { x: 360, y: 160 },
    lKnee: { x: 156, y: 404 },
    rKnee: { x: 248, y: 396 },
  }),
  posePreset('floor-side-sit', '侧坐地面', 'Side floor sitting', {
    head: { x: 206, y: 76 },
    neck: { x: 206, y: 124 },
    chest: { x: 210, y: 198 },
    pelvis: { x: 220, y: 326 },
    lKnee: { x: 144, y: 406 },
    lAnkle: { x: 88, y: 456 },
    rKnee: { x: 316, y: 400 },
    rAnkle: { x: 382, y: 440 },
    lWrist: { x: 148, y: 330 },
    rWrist: { x: 286, y: 330 },
  }),
  posePreset('knee-hug-sit', '抱膝坐', 'Knees hugged sitting', {
    head: { x: 210, y: 92 },
    neck: { x: 210, y: 138 },
    chest: { x: 210, y: 214 },
    pelvis: { x: 210, y: 334 },
    lElbow: { x: 166, y: 256 },
    rElbow: { x: 254, y: 256 },
    lWrist: { x: 186, y: 326 },
    rWrist: { x: 234, y: 326 },
    lKnee: { x: 158, y: 382 },
    rKnee: { x: 262, y: 382 },
    lAnkle: { x: 156, y: 474 },
    rAnkle: { x: 264, y: 474 },
  }),
  posePreset('lying-back', '仰躺', 'Lying on back', {
    head: { x: 92, y: 250 },
    neck: { x: 132, y: 250 },
    chest: { x: 200, y: 252 },
    pelvis: { x: 294, y: 258 },
    lShoulder: { x: 160, y: 228 },
    rShoulder: { x: 160, y: 276 },
    lElbow: { x: 218, y: 206 },
    lWrist: { x: 276, y: 184 },
    rElbow: { x: 218, y: 300 },
    rWrist: { x: 276, y: 326 },
    lHip: { x: 286, y: 234 },
    rHip: { x: 286, y: 282 },
    lKnee: { x: 346, y: 220 },
    rKnee: { x: 346, y: 300 },
    lAnkle: { x: 404, y: 210 },
    rAnkle: { x: 404, y: 310 },
  }),
  posePreset('prone-lying', '俯卧', 'Lying face down', {
    head: { x: 102, y: 250 },
    neck: { x: 144, y: 250 },
    chest: { x: 214, y: 250 },
    pelvis: { x: 306, y: 254 },
    lElbow: { x: 174, y: 200 },
    lWrist: { x: 130, y: 158 },
    rElbow: { x: 174, y: 300 },
    rWrist: { x: 130, y: 342 },
    lKnee: { x: 356, y: 224 },
    rKnee: { x: 356, y: 294 },
    lAnkle: { x: 408, y: 212 },
    rAnkle: { x: 408, y: 306 },
  }),
  posePreset('sleep-curled', '蜷缩睡姿', 'Curled sleeping pose', {
    head: { x: 142, y: 170 },
    neck: { x: 170, y: 200 },
    chest: { x: 210, y: 244 },
    pelvis: { x: 250, y: 310 },
    lElbow: { x: 154, y: 266 },
    lWrist: { x: 118, y: 304 },
    rElbow: { x: 250, y: 220 },
    rWrist: { x: 286, y: 188 },
    lKnee: { x: 182, y: 360 },
    rKnee: { x: 310, y: 344 },
    lAnkle: { x: 132, y: 392 },
    rAnkle: { x: 340, y: 396 },
  }),
  posePreset('swimming', '游泳划水', 'Swimming stroke', {
    head: { x: 210, y: 128 },
    neck: { x: 210, y: 164 },
    chest: { x: 210, y: 226 },
    pelvis: { x: 210, y: 328 },
    lElbow: { x: 100, y: 160 },
    lWrist: { x: 40, y: 128 },
    rElbow: { x: 318, y: 182 },
    rWrist: { x: 380, y: 224 },
    lKnee: { x: 168, y: 404 },
    lAnkle: { x: 126, y: 486 },
    rKnee: { x: 252, y: 404 },
    rAnkle: { x: 294, y: 486 },
  }),
  posePreset('superhero-flight', '超人飞行', 'Superhero flying', {
    head: { x: 270, y: 136 },
    neck: { x: 250, y: 160 },
    chest: { x: 210, y: 204 },
    pelvis: { x: 160, y: 260 },
    lElbow: { x: 152, y: 146 },
    lWrist: { x: 86, y: 108 },
    rElbow: { x: 310, y: 174 },
    rWrist: { x: 382, y: 150 },
    lKnee: { x: 120, y: 316 },
    lAnkle: { x: 62, y: 370 },
    rKnee: { x: 214, y: 342 },
    rAnkle: { x: 182, y: 420 },
  }),
  posePreset('meditation', '冥想打坐', 'Meditation pose', {
    head: { x: 210, y: 76 },
    neck: { x: 210, y: 124 },
    chest: { x: 210, y: 198 },
    pelvis: { x: 210, y: 318 },
    lElbow: { x: 150, y: 260 },
    lWrist: { x: 178, y: 328 },
    rElbow: { x: 270, y: 260 },
    rWrist: { x: 242, y: 328 },
    lKnee: { x: 126, y: 412 },
    rKnee: { x: 294, y: 412 },
    lAnkle: { x: 248, y: 450 },
    rAnkle: { x: 172, y: 450 },
  }),
  posePreset('surprised-step-back', '惊讶后退', 'Surprised step back', {
    head: { x: 206, y: 50 },
    chest: { x: 210, y: 168 },
    pelvis: { x: 232, y: 280 },
    lElbow: { x: 116, y: 150 },
    lWrist: { x: 62, y: 118 },
    rElbow: { x: 308, y: 150 },
    rWrist: { x: 362, y: 118 },
    lKnee: { x: 164, y: 404 },
    rKnee: { x: 286, y: 390 },
    lAnkle: { x: 132, y: 490 },
    rAnkle: { x: 326, y: 464 },
  }),
  posePreset('sneaking', '潜行动作', 'Sneaking pose', {
    head: { x: 232, y: 86 },
    neck: { x: 222, y: 128 },
    chest: { x: 206, y: 198 },
    pelvis: { x: 198, y: 312 },
    lElbow: { x: 124, y: 210 },
    lWrist: { x: 80, y: 250 },
    rElbow: { x: 286, y: 214 },
    rWrist: { x: 340, y: 250 },
    lKnee: { x: 144, y: 404 },
    lAnkle: { x: 104, y: 486 },
    rKnee: { x: 278, y: 396 },
    rAnkle: { x: 326, y: 468 },
  }),
  posePreset('climbing', '攀爬', 'Climbing pose', {
    head: { x: 214, y: 70 },
    neck: { x: 210, y: 116 },
    chest: { x: 206, y: 184 },
    pelvis: { x: 216, y: 294 },
    lElbow: { x: 128, y: 96 },
    lWrist: { x: 92, y: 34 },
    rElbow: { x: 298, y: 138 },
    rWrist: { x: 348, y: 78 },
    lKnee: { x: 150, y: 372 },
    lAnkle: { x: 100, y: 440 },
    rKnee: { x: 290, y: 386 },
    rAnkle: { x: 326, y: 474 },
  }),
  posePreset('hanging', '悬挂', 'Hanging pose', {
    head: { x: 210, y: 92 },
    neck: { x: 210, y: 140 },
    chest: { x: 210, y: 218 },
    pelvis: { x: 210, y: 332 },
    lElbow: { x: 160, y: 72 },
    lWrist: { x: 150, y: 18 },
    rElbow: { x: 260, y: 72 },
    rWrist: { x: 270, y: 18 },
    lKnee: { x: 178, y: 418 },
    rKnee: { x: 242, y: 418 },
  }),
  posePreset('carrying-box', '抱箱子', 'Carrying box', {
    lElbow: { x: 150, y: 210 },
    lWrist: { x: 176, y: 240 },
    rElbow: { x: 270, y: 210 },
    rWrist: { x: 244, y: 240 },
    chest: { x: 210, y: 174 },
    lKnee: { x: 174, y: 398 },
    rKnee: { x: 246, y: 398 },
  }),
  posePreset('selfie', '自拍', 'Selfie pose', {
    head: { x: 202, y: 54 },
    lElbow: { x: 150, y: 154 },
    lWrist: { x: 194, y: 86 },
    rElbow: { x: 306, y: 144 },
    rWrist: { x: 378, y: 84 },
    chest: { x: 212, y: 172 },
  }),
  posePreset('umbrella', '撑伞', 'Holding umbrella', {
    lElbow: { x: 154, y: 138 },
    lWrist: { x: 198, y: 52 },
    rElbow: { x: 292, y: 226 },
    rWrist: { x: 310, y: 318 },
    head: { x: 210, y: 54 },
  }),
  posePreset('skirt-twirl', '裙摆旋转', 'Skirt twirl', {
    head: { x: 218, y: 50 },
    chest: { x: 212, y: 168 },
    pelvis: { x: 206, y: 276 },
    lElbow: { x: 104, y: 180 },
    lWrist: { x: 44, y: 204 },
    rElbow: { x: 316, y: 180 },
    rWrist: { x: 376, y: 204 },
    lKnee: { x: 186, y: 404 },
    rKnee: { x: 252, y: 390 },
  }),
  posePreset('cape-spread', '展开披风', 'Cape spread', {
    lElbow: { x: 98, y: 164 },
    lWrist: { x: 30, y: 146 },
    rElbow: { x: 322, y: 164 },
    rWrist: { x: 390, y: 146 },
    chest: { x: 210, y: 172 },
    pelvis: { x: 210, y: 278 },
  }),
  posePreset('sword-overhead', '举剑劈砍', 'Sword overhead slash', {
    lElbow: { x: 172, y: 84 },
    lWrist: { x: 198, y: 28 },
    rElbow: { x: 248, y: 84 },
    rWrist: { x: 222, y: 28 },
    lKnee: { x: 154, y: 394 },
    rKnee: { x: 274, y: 394 },
  }),
  posePreset('shield-block', '举盾防御', 'Shield block', {
    lElbow: { x: 136, y: 174 },
    lWrist: { x: 78, y: 156 },
    rElbow: { x: 272, y: 228 },
    rWrist: { x: 316, y: 310 },
    lKnee: { x: 154, y: 394 },
    rKnee: { x: 274, y: 394 },
  }),
  posePreset('magic-casting', '施法', 'Magic casting', {
    lElbow: { x: 124, y: 156 },
    lWrist: { x: 58, y: 124 },
    rElbow: { x: 296, y: 156 },
    rWrist: { x: 362, y: 124 },
    head: { x: 210, y: 48 },
    chest: { x: 210, y: 166 },
  }),
  posePreset('gun-aim', '持枪瞄准', 'Aiming pose', {
    chest: { x: 220, y: 172 },
    lElbow: { x: 170, y: 170 },
    lWrist: { x: 250, y: 160 },
    rElbow: { x: 292, y: 160 },
    rWrist: { x: 366, y: 150 },
    lKnee: { x: 158, y: 396 },
    rKnee: { x: 276, y: 392 },
  }),
  posePreset('skateboard', '滑板姿势', 'Skateboard pose', {
    head: { x: 218, y: 72 },
    neck: { x: 214, y: 118 },
    chest: { x: 210, y: 190 },
    pelvis: { x: 208, y: 304 },
    lElbow: { x: 114, y: 210 },
    lWrist: { x: 56, y: 244 },
    rElbow: { x: 304, y: 210 },
    rWrist: { x: 364, y: 244 },
    lKnee: { x: 154, y: 400 },
    rKnee: { x: 286, y: 400 },
    lAnkle: { x: 96, y: 470 },
    rAnkle: { x: 334, y: 470 },
  }),
  posePreset('cycling', '骑行动作', 'Cycling pose', {
    head: { x: 224, y: 84 },
    neck: { x: 218, y: 126 },
    chest: { x: 210, y: 198 },
    pelvis: { x: 206, y: 310 },
    lElbow: { x: 150, y: 214 },
    lWrist: { x: 104, y: 244 },
    rElbow: { x: 286, y: 214 },
    rWrist: { x: 332, y: 244 },
    lKnee: { x: 150, y: 382 },
    lAnkle: { x: 190, y: 450 },
    rKnee: { x: 292, y: 382 },
    rAnkle: { x: 250, y: 450 },
  }),
  posePreset('horse-riding', '骑乘姿势', 'Riding pose', {
    head: { x: 210, y: 74 },
    neck: { x: 210, y: 122 },
    chest: { x: 210, y: 194 },
    pelvis: { x: 210, y: 308 },
    lElbow: { x: 158, y: 212 },
    lWrist: { x: 176, y: 274 },
    rElbow: { x: 262, y: 212 },
    rWrist: { x: 244, y: 274 },
    lKnee: { x: 116, y: 386 },
    lAnkle: { x: 76, y: 470 },
    rKnee: { x: 304, y: 386 },
    rAnkle: { x: 344, y: 470 },
  }),
  posePreset('handstand', '倒立', 'Handstand pose', {
    head: { x: 210, y: 350 },
    neck: { x: 210, y: 310 },
    chest: { x: 210, y: 242 },
    pelvis: { x: 210, y: 138 },
    lElbow: { x: 166, y: 382 },
    lWrist: { x: 146, y: 460 },
    rElbow: { x: 254, y: 382 },
    rWrist: { x: 274, y: 460 },
    lKnee: { x: 166, y: 70 },
    lAnkle: { x: 126, y: 22 },
    rKnee: { x: 254, y: 70 },
    rAnkle: { x: 294, y: 22 },
  }),
  posePreset('cartwheel', '侧手翻', 'Cartwheel pose', {
    head: { x: 210, y: 292 },
    neck: { x: 210, y: 252 },
    chest: { x: 210, y: 190 },
    pelvis: { x: 210, y: 126 },
    lElbow: { x: 146, y: 318 },
    lWrist: { x: 94, y: 390 },
    rElbow: { x: 274, y: 318 },
    rWrist: { x: 326, y: 390 },
    lKnee: { x: 142, y: 74 },
    lAnkle: { x: 80, y: 28 },
    rKnee: { x: 278, y: 74 },
    rAnkle: { x: 340, y: 28 },
  }),
  posePreset('split-pose', '横劈叉', 'Side split', {
    head: { x: 210, y: 80 },
    neck: { x: 210, y: 126 },
    chest: { x: 210, y: 198 },
    pelvis: { x: 210, y: 326 },
    lKnee: { x: 118, y: 406 },
    lAnkle: { x: 34, y: 442 },
    rKnee: { x: 302, y: 406 },
    rAnkle: { x: 386, y: 442 },
    lWrist: { x: 164, y: 332 },
    rWrist: { x: 256, y: 332 },
  }),
  posePreset('front-split', '竖劈叉', 'Front split', {
    pelvis: { x: 210, y: 326 },
    lKnee: { x: 126, y: 410 },
    lAnkle: { x: 42, y: 448 },
    rKnee: { x: 294, y: 390 },
    rAnkle: { x: 376, y: 366 },
    lWrist: { x: 160, y: 326 },
    rWrist: { x: 260, y: 326 },
  }),
  posePreset('kneel-offer', '单膝递物', 'Kneeling offering', {
    pelvis: { x: 210, y: 286 },
    lKnee: { x: 164, y: 406 },
    lAnkle: { x: 118, y: 488 },
    rKnee: { x: 282, y: 356 },
    rAnkle: { x: 288, y: 476 },
    lElbow: { x: 160, y: 198 },
    lWrist: { x: 92, y: 180 },
    rElbow: { x: 254, y: 198 },
    rWrist: { x: 328, y: 180 },
  }),
  posePreset('reach-up', '向上够取', 'Reaching upward', {
    head: { x: 206, y: 48 },
    chest: { x: 210, y: 168 },
    lElbow: { x: 156, y: 78 },
    lWrist: { x: 142, y: 20 },
    rElbow: { x: 264, y: 86 },
    rWrist: { x: 292, y: 28 },
    pelvis: { x: 214, y: 278 },
  }),
  posePreset('reach-down', '弯腰拾取', 'Reaching down', {
    head: { x: 238, y: 144 },
    neck: { x: 224, y: 168 },
    chest: { x: 210, y: 224 },
    pelvis: { x: 202, y: 314 },
    lElbow: { x: 160, y: 282 },
    lWrist: { x: 136, y: 362 },
    rElbow: { x: 282, y: 282 },
    rWrist: { x: 308, y: 362 },
    lKnee: { x: 172, y: 410 },
    rKnee: { x: 246, y: 410 },
  }),
  posePreset('dramatic-back-arch', '后仰张力', 'Dramatic back arch', {
    head: { x: 184, y: 58 },
    neck: { x: 198, y: 104 },
    chest: { x: 218, y: 170 },
    pelvis: { x: 206, y: 286 },
    lElbow: { x: 112, y: 118 },
    lWrist: { x: 56, y: 86 },
    rElbow: { x: 316, y: 118 },
    rWrist: { x: 372, y: 86 },
    lKnee: { x: 176, y: 404 },
    rKnee: { x: 246, y: 404 },
  }),
  posePreset('walking-away', '背影行走', 'Walking away pose', {
    head: { x: 210, y: 54 },
    neck: { x: 210, y: 104 },
    chest: { x: 210, y: 174 },
    pelvis: { x: 210, y: 282 },
    lElbow: { x: 134, y: 226 },
    lWrist: { x: 118, y: 314 },
    rElbow: { x: 286, y: 226 },
    rWrist: { x: 302, y: 314 },
    lKnee: { x: 146, y: 396 },
    lAnkle: { x: 114, y: 486 },
    rKnee: { x: 270, y: 398 },
    rAnkle: { x: 294, y: 486 },
  }),
];

const POSE_PRESETS: PosePreset[] = CORE_POSE_PRESETS;

const VIEW_OPTIONS = [
  { id: 'front', zh: '正面', en: 'front view' },
  { id: 'three-quarter', zh: '四分之三', en: 'three-quarter view' },
  { id: 'side', zh: '侧面', en: 'side view' },
  { id: 'back', zh: '背面', en: 'back view' },
];

const SHOT_OPTIONS = [
  { id: 'full-body', zh: '全身', en: 'full-body shot' },
  { id: 'medium-full', zh: '七分身', en: 'medium-full shot' },
  { id: 'medium', zh: '中景', en: 'medium shot' },
  { id: 'close', zh: '近景', en: 'close-up pose crop' },
];

const POSE_INTENSITY_OPTIONS = [
  {
    id: 'natural',
    zh: '自然',
    en: 'natural believable motion, relaxed body tension',
  },
  {
    id: 'exaggerated',
    zh: '夸张',
    en: 'exaggerated expressive motion, amplified silhouette and clear gesture',
  },
  {
    id: 'manga',
    zh: '漫画感',
    en: 'manga-style dynamic body language, readable silhouette and dramatic gesture',
  },
  {
    id: 'combat',
    zh: '战斗感',
    en: 'combat-ready motion, strong body tension, decisive action pose',
  },
  {
    id: 'stage',
    zh: '舞台感',
    en: 'stage performance pose, elegant line of action, theatrical presentation',
  },
];

const POSE_BATCH_MODES: Array<{ id: PoseBatchMode; zh: string; en: string }> = [
  { id: 'next', zh: '分镜连续预设', en: 'storyboard presets' },
  { id: 'random', zh: '随机常用姿态', en: 'random poses' },
  { id: 'current', zh: '复制当前姿态', en: 'duplicate current pose' },
];

const POSE_RENDER_MODES: Array<{ id: PoseRenderMode; zh: string; en: string }> = [
  { id: 'lineart', zh: '线稿图', en: 'Line art' },
  { id: 'openpose', zh: 'OpenPose图', en: 'OpenPose' },
  { id: 'coco', zh: 'COCO图', en: 'COCO' },
];

const POSE_CANVAS_RATIOS: Array<{ id: PoseCanvasRatioId; label: string; width: number; height: number }> = [
  { id: 'default', label: '默认', width: VIEW_W, height: VIEW_H },
  { id: '1:1', label: '1:1', width: 1, height: 1 },
  { id: '4:3', label: '4:3', width: 4, height: 3 },
  { id: '3:4', label: '3:4', width: 3, height: 4 },
  { id: '16:9', label: '16:9', width: 16, height: 9 },
  { id: '9:16', label: '9:16', width: 9, height: 16 },
  { id: '3:2', label: '3:2', width: 3, height: 2 },
  { id: '2:3', label: '2:3', width: 2, height: 3 },
  { id: 'custom', label: '自定义', width: VIEW_W, height: VIEW_H },
];

function isPosePoint(value: unknown): value is PosePoint {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as PosePoint).x === 'number' &&
    typeof (value as PosePoint).y === 'number'
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function safeCanvasRatioId(value: unknown): PoseCanvasRatioId {
  const id = typeof value === 'string' ? value : '';
  return POSE_CANVAS_RATIOS.some((item) => item.id === id) ? (id as PoseCanvasRatioId) : 'default';
}

function safeCanvasRatioDimension(value: unknown, fallback: number): number {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? clamp(n, 1, 9999) : fallback;
}

function poseCanvasBoundsFor(ratioId: PoseCanvasRatioId, customWidth = VIEW_W, customHeight = VIEW_H): PoseCanvasBounds {
  const option = POSE_CANVAS_RATIOS.find((item) => item.id === ratioId) || POSE_CANVAS_RATIOS[0];
  const sourceWidth = ratioId === 'custom' ? safeCanvasRatioDimension(customWidth, VIEW_W) : option.width;
  const sourceHeight = ratioId === 'custom' ? safeCanvasRatioDimension(customHeight, VIEW_H) : option.height;
  const ratio = clamp(sourceWidth / Math.max(sourceHeight, 1), 0.2, 5);
  const baseRatio = VIEW_W / VIEW_H;
  const width = ratio >= baseRatio ? VIEW_H * ratio : VIEW_W;
  const height = ratio >= baseRatio ? VIEW_H : VIEW_W / ratio;
  const minX = (VIEW_W - width) / 2;
  const minY = (VIEW_H - height) / 2;
  return {
    id: ratioId,
    width,
    height,
    minX,
    minY,
    maxX: minX + width,
    maxY: minY + height,
    ratio,
  };
}

function poseOutputSizeFor(bounds: PoseCanvasBounds) {
  if (bounds.ratio >= 1) {
    return { width: POSE_OUTPUT_W, height: Math.max(1, Math.round(POSE_OUTPUT_W / bounds.ratio)) };
  }
  return { width: Math.max(1, Math.round(POSE_OUTPUT_W * bounds.ratio)), height: POSE_OUTPUT_W };
}

function poseCanvasPreviewSizeFor(bounds: PoseCanvasBounds) {
  const panelRatio = POSE_CANVAS_PANEL_W / POSE_CANVAS_PANEL_H;
  if (bounds.ratio >= panelRatio) {
    return {
      width: POSE_CANVAS_PANEL_W,
      height: Math.max(1, POSE_CANVAS_PANEL_W / bounds.ratio),
    };
  }
  return {
    width: Math.max(1, POSE_CANVAS_PANEL_H * bounds.ratio),
    height: POSE_CANVAS_PANEL_H,
  };
}

function clampPointToBounds(point: PosePoint, bounds: PoseCanvasBounds, padding = POSE_CANVAS_PADDING): PosePoint {
  return {
    x: clamp(point.x, bounds.minX + padding, bounds.maxX - padding),
    y: clamp(point.y, bounds.minY + padding, bounds.maxY - padding),
  };
}

function poseBounds(points: PosePoints) {
  const all = Object.values(points);
  const minX = Math.min(...all.map((point) => point.x));
  const maxX = Math.max(...all.map((point) => point.x));
  const minY = Math.min(...all.map((point) => point.y));
  const maxY = Math.max(...all.map((point) => point.y));
  return {
    minX,
    maxX,
    minY,
    maxY,
    width: maxX - minX,
    height: maxY - minY,
    center: { x: (minX + maxX) / 2, y: (minY + maxY) / 2 },
  };
}

function poseTransformFrameFor(box: ReturnType<typeof poseBounds>, bounds: PoseCanvasBounds) {
  const minX = clamp(box.minX - 18, bounds.minX + 6, bounds.maxX - 46);
  const minY = clamp(box.minY - 18, bounds.minY + 6, bounds.maxY - 46);
  const maxX = clamp(box.maxX + 18, minX + 40, bounds.maxX - 6);
  const maxY = clamp(box.maxY + 18, minY + 40, bounds.maxY - 6);
  return {
    minX,
    minY,
    maxX,
    maxY,
    width: maxX - minX,
    height: maxY - minY,
    center: {
      x: clamp((minX + maxX) / 2, bounds.minX + 14, bounds.maxX - 14),
      y: clamp((minY + maxY) / 2, bounds.minY + 14, bounds.maxY - 14),
    },
    rotate: {
      x: clamp((minX + maxX) / 2, bounds.minX + 14, bounds.maxX - 14),
      y: clamp(minY - 34, bounds.minY + 14, bounds.maxY - 14),
    },
    scale: {
      x: clamp(maxX + 14, bounds.minX + 14, bounds.maxX - 14),
      y: clamp(maxY + 14, bounds.minY + 14, bounds.maxY - 14),
    },
  };
}

function safeIntensityId(value: unknown): string {
  const id = typeof value === 'string' ? value : '';
  return POSE_INTENSITY_OPTIONS.some((item) => item.id === id) ? id : 'natural';
}

function safeBatchMode(value: unknown): PoseBatchMode {
  const id = typeof value === 'string' ? value : '';
  return POSE_BATCH_MODES.some((item) => item.id === id) ? (id as PoseBatchMode) : 'next';
}

function safeBatchCount(value: unknown): number {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? clamp(n, 1, 8) : 4;
}

function safeRenderMode(value: unknown): PoseRenderMode {
  const id = typeof value === 'string' ? value : '';
  return POSE_RENDER_MODES.some((item) => item.id === id) ? (id as PoseRenderMode) : 'lineart';
}

function safeHandShape(value: unknown): HandShape {
  const id = typeof value === 'string' ? value : '';
  return HAND_SHAPE_OPTIONS.some((item) => item.id === id) ? (id as HandShape) : 'open';
}

function safeHandDirection(value: unknown): HandDirection {
  const id = typeof value === 'string' ? value : '';
  return HAND_DIRECTION_OPTIONS.some((item) => item.id === id) ? (id as HandDirection) : 'front';
}

function safeHandControls(value: unknown): HandControls {
  if (!value || typeof value !== 'object') return { ...DEFAULT_HAND_CONTROLS };
  const raw = value as Record<string, any>;
  return {
    left: {
      shape: safeHandShape(raw.left?.shape),
      direction: safeHandDirection(raw.left?.direction),
    },
    right: {
      shape: safeHandShape(raw.right?.shape),
      direction: safeHandDirection(raw.right?.direction),
    },
  };
}

function buildHandPrompt(handControls: HandControls, language: Lang): string {
  const sideText = (side: 'left' | 'right') => {
    const shape = HAND_SHAPE_OPTIONS.find((item) => item.id === handControls[side].shape) || HAND_SHAPE_OPTIONS[0];
    const direction = HAND_DIRECTION_OPTIONS.find((item) => item.id === handControls[side].direction) || HAND_DIRECTION_OPTIONS[0];
    if (language === 'zh') return `${side === 'left' ? '左手' : '右手'}${shape.zh}、${direction.zh}`;
    return `${side} hand ${shape.en}, ${direction.en}`;
  };
  return `${sideText('left')}${language === 'zh' ? '；' : '; '}${sideText('right')}`;
}

function constrainFootPoint(
  key: JointKey,
  point: PosePoint,
  points: PosePoints,
  bounds: PoseCanvasBounds = DEFAULT_CANVAS_BOUNDS,
): PosePoint {
  if (key !== 'lFoot' && key !== 'rFoot') return point;
  const ankleKey: JointKey = key === 'lFoot' ? 'lAnkle' : 'rAnkle';
  const kneeKey: JointKey = key === 'lFoot' ? 'lKnee' : 'rKnee';
  const ankle = points[ankleKey];
  const knee = points[kneeKey];
  const rawDistance = distance(ankle, point);
  const fallbackDir = unit(knee, ankle);
  const dir = rawDistance < 1 ? fallbackDir : unit(ankle, point);
  const nextDistance = clamp(rawDistance, FOOT_MIN_DISTANCE, FOOT_MAX_DISTANCE);
  return clampPointToBounds({
    x: ankle.x + dir.x * nextDistance,
    y: ankle.y + dir.y * nextDistance,
  }, bounds);
}

function constrainFootPoints(points: PosePoints, bounds: PoseCanvasBounds = DEFAULT_CANVAS_BOUNDS): PosePoints {
  const next = clonePoints(points);
  next.lFoot = constrainFootPoint('lFoot', next.lFoot, next, bounds);
  next.rFoot = constrainFootPoint('rFoot', next.rFoot, next, bounds);
  return next;
}

function shiftPosePoints(points: PosePoints, dx: number, dy = 0, bounds: PoseCanvasBounds = DEFAULT_CANVAS_BOUNDS): PosePoints {
  const next = clonePoints(points);
  for (const key of Object.keys(next) as JointKey[]) {
    next[key] = clampPointToBounds({ x: next[key].x + dx, y: next[key].y + dy }, bounds);
  }
  return constrainFootPoints(next, bounds);
}

function translatePosePoints(points: PosePoints, dx: number, dy: number, bounds: PoseCanvasBounds = DEFAULT_CANVAS_BOUNDS): PosePoints {
  const box = poseBounds(points);
  const safeDx = clamp(dx, bounds.minX + POSE_CANVAS_PADDING - box.minX, bounds.maxX - POSE_CANVAS_PADDING - box.maxX);
  const safeDy = clamp(dy, bounds.minY + POSE_CANVAS_PADDING - box.minY, bounds.maxY - POSE_CANVAS_PADDING - box.maxY);
  return shiftPosePoints(points, safeDx, safeDy, bounds);
}

function fitPosePointsToBounds(points: PosePoints, bounds: PoseCanvasBounds = DEFAULT_CANVAS_BOUNDS): PosePoints {
  return translatePosePoints(points, 0, 0, bounds);
}

function maxScaleWithinBounds(points: PosePoints, center: PosePoint, bounds: PoseCanvasBounds): number {
  let maxScale = 2.5;
  for (const point of Object.values(points)) {
    const dx = point.x - center.x;
    const dy = point.y - center.y;
    if (dx > 0.01) maxScale = Math.min(maxScale, (bounds.maxX - POSE_CANVAS_PADDING - center.x) / dx);
    if (dx < -0.01) maxScale = Math.min(maxScale, (bounds.minX + POSE_CANVAS_PADDING - center.x) / dx);
    if (dy > 0.01) maxScale = Math.min(maxScale, (bounds.maxY - POSE_CANVAS_PADDING - center.y) / dy);
    if (dy < -0.01) maxScale = Math.min(maxScale, (bounds.minY + POSE_CANVAS_PADDING - center.y) / dy);
  }
  return Math.max(0.35, maxScale);
}

function scalePosePoints(
  points: PosePoints,
  center: PosePoint,
  factor: number,
  bounds: PoseCanvasBounds = DEFAULT_CANVAS_BOUNDS,
): PosePoints {
  const safeFactor = clamp(factor, 0.35, maxScaleWithinBounds(points, center, bounds));
  const next = clonePoints(points);
  for (const key of Object.keys(next) as JointKey[]) {
    next[key] = {
      x: center.x + (points[key].x - center.x) * safeFactor,
      y: center.y + (points[key].y - center.y) * safeFactor,
    };
  }
  return fitPosePointsToBounds(constrainFootPoints(next, bounds), bounds);
}

function rotatePosePoints(
  points: PosePoints,
  center: PosePoint,
  radians: number,
  bounds: PoseCanvasBounds = DEFAULT_CANVAS_BOUNDS,
): PosePoints {
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const next = clonePoints(points);
  for (const key of Object.keys(next) as JointKey[]) {
    const dx = points[key].x - center.x;
    const dy = points[key].y - center.y;
    next[key] = {
      x: center.x + dx * cos - dy * sin,
      y: center.y + dx * sin + dy * cos,
    };
  }
  return fitPosePointsToBounds(constrainFootPoints(next, bounds), bounds);
}

function normalizePoints(value: unknown): PosePoints {
  if (!value || typeof value !== 'object') return shiftPosePoints(DEFAULT_POINTS, VIEW_X_OFFSET);
  const out = shiftPosePoints(DEFAULT_POINTS, VIEW_X_OFFSET);
  for (const key of Object.keys(DEFAULT_POINTS) as JointKey[]) {
    const point = (value as Record<string, unknown>)[key];
    if (isPosePoint(point)) {
      out[key] = { x: clamp(point.x, 0, VIEW_W), y: clamp(point.y, 0, VIEW_H) };
    }
  }
  return constrainFootPoints(out);
}

function upgradeLegacyPoints(value: unknown): PosePoints {
  if (!value || typeof value !== 'object') return shiftPosePoints(DEFAULT_POINTS, VIEW_X_OFFSET);
  const out = clonePoints(DEFAULT_POINTS);
  for (const key of Object.keys(DEFAULT_POINTS) as JointKey[]) {
    const point = (value as Record<string, unknown>)[key];
    if (!isPosePoint(point)) continue;
    const oldBase = LEGACY_DEFAULT_POINTS[key];
    const newBase = DEFAULT_POINTS[key];
    out[key] = {
      x: clamp(newBase.x + (point.x - oldBase.x) * 0.82, 0, VIEW_W),
      y: clamp(newBase.y + (point.y - oldBase.y) * 1.08, 0, VIEW_H),
    };
  }
  return shiftPosePoints(out, VIEW_X_OFFSET);
}

function upgradeNarrowTallPoints(value: unknown): PosePoints {
  if (!value || typeof value !== 'object') return shiftPosePoints(DEFAULT_POINTS, VIEW_X_OFFSET);
  const out = clonePoints(DEFAULT_POINTS);
  for (const key of Object.keys(DEFAULT_POINTS) as JointKey[]) {
    const point = (value as Record<string, unknown>)[key];
    if (!isPosePoint(point)) continue;
    out[key] = {
      x: clamp(point.x + 50 + VIEW_X_OFFSET, 0, VIEW_W),
      y: clamp(point.y, 0, VIEW_H),
    };
  }
  return constrainFootPoints(out);
}

function loadPosePoints(value: unknown, version: unknown): PosePoints {
  const numericVersion = Number(version);
  if (numericVersion >= POSE_POINT_VERSION) return normalizePoints(value);
  if (numericVersion === 3) return shiftPosePoints(normalizePoints(value), VIEW_X_OFFSET);
  if (numericVersion === 2) return upgradeNarrowTallPoints(value);
  return upgradeLegacyPoints(value);
}

function loadPosePeople(value: unknown, version: unknown): PosePoints[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => loadPosePoints(item, version))
    .filter(Boolean)
    .slice(0, MAX_POSE_PEOPLE);
}

function interpolatePoints(a: PosePoints, b: PosePoints, t: number): PosePoints {
  const out = clonePoints(a);
  for (const key of Object.keys(out) as JointKey[]) {
    out[key] = at(a[key], b[key], t);
  }
  return constrainFootPoints(out);
}

function mirrorPoints(points: PosePoints, bounds: PoseCanvasBounds = DEFAULT_CANVAS_BOUNDS): PosePoints {
  const next = clonePoints(points);
  const mirror = (point: PosePoint): PosePoint => ({ x: bounds.minX + bounds.maxX - point.x, y: point.y });
  const swapped = new Set<JointKey>();
  for (const [left, right] of MIRROR_PAIRS) {
    next[left] = mirror(points[right]);
    next[right] = mirror(points[left]);
    swapped.add(left);
    swapped.add(right);
  }
  for (const key of Object.keys(points) as JointKey[]) {
    if (!swapped.has(key)) next[key] = mirror(points[key]);
  }
  return constrainFootPoints(next, bounds);
}

function buildPosePrompt(args: {
  presetId: string;
  viewId: string;
  shotId: string;
  intensityId: string;
  language: Lang;
  custom: string;
  handControls?: HandControls;
}): string {
  const preset = POSE_PRESETS.find((item) => item.id === args.presetId) || POSE_PRESETS[0];
  const view = VIEW_OPTIONS.find((item) => item.id === args.viewId) || VIEW_OPTIONS[0];
  const shot = SHOT_OPTIONS.find((item) => item.id === args.shotId) || SHOT_OPTIONS[0];
  const intensity = POSE_INTENSITY_OPTIONS.find((item) => item.id === args.intensityId) || POSE_INTENSITY_OPTIONS[0];
  const custom = args.custom.trim();
  const handPrompt = args.handControls ? buildHandPrompt(args.handControls, args.language) : '';
  if (args.language === 'zh') {
    return [preset.promptZh, view.zh, shot.zh, intensity.zh, handPrompt, '人体结构体块线稿姿态参考图，关节、手脚和躯干分段清晰，可作为生成参考', custom]
      .filter(Boolean)
      .join('，');
  }
  return [preset.promptEn, view.en, shot.en, intensity.en, handPrompt, 'clean human mannequin anatomy line-art pose reference, visible body volumes, hands, feet, and joint structure', custom]
    .filter(Boolean)
    .join(', ');
}

function combinePromptParts(upstreamTexts: string[], posePrompt: string, language: Lang): string {
  const upstream = Array.from(new Set(upstreamTexts.map((text) => text.trim()).filter(Boolean)));
  if (upstream.length === 0) return posePrompt;
  if (language === 'zh') return [...upstream, `动作姿势：${posePrompt}`].join('，');
  return [...upstream, `pose and action direction: ${posePrompt}`].join(', ');
}

function poseMetadata(
  points: PosePoints,
  presetId: string,
  viewId: string,
  shotId: string,
  intensityId: string,
  language: Lang,
  custom: string,
  prompt: string,
  extras?: { people?: PosePoints[]; handControls?: HandControls; canvas?: PoseCanvasBounds },
) {
  return {
    schema: POSE_SCHEMA,
    version: 4,
    pointVersion: POSE_POINT_VERSION,
    canvas: extras?.canvas
      ? {
          ratioId: extras.canvas.id,
          width: Math.round(extras.canvas.width),
          height: Math.round(extras.canvas.height),
          ratio: Number(extras.canvas.ratio.toFixed(4)),
        }
      : undefined,
    presetId,
    viewId,
    shotId,
    intensityId,
    language,
    custom,
    prompt,
    points,
    people: extras?.people && extras.people.length > 1 ? extras.people.map(clonePoints) : undefined,
    handControls: extras?.handControls,
  };
}

function makePoseBackup(args: {
  points: PosePoints;
  hasPeople?: boolean;
  presetId: string;
  viewId: string;
  shotId: string;
  intensityId: string;
  language: Lang;
  custom: string;
  prompt?: string;
  name?: string;
  people?: PosePoints[];
  handControls?: HandControls;
  canvasRatioId?: PoseCanvasRatioId;
  canvasCustomWidth?: number;
  canvasCustomHeight?: number;
}): PoseBackup {
  return {
    schema: POSE_SCHEMA,
    version: 4,
    pointVersion: POSE_POINT_VERSION,
    hasPeople: args.hasPeople !== false,
    presetId: args.presetId,
    viewId: args.viewId,
    shotId: args.shotId,
    intensityId: safeIntensityId(args.intensityId),
    language: args.language,
    custom: args.custom,
    points: clonePoints(args.points),
    people: args.people && args.people.length !== 1 ? args.people.map(clonePoints).slice(0, MAX_POSE_PEOPLE) : undefined,
    handControls: safeHandControls(args.handControls),
    canvasRatioId: safeCanvasRatioId(args.canvasRatioId),
    canvasCustomWidth: safeCanvasRatioDimension(args.canvasCustomWidth, VIEW_W),
    canvasCustomHeight: safeCanvasRatioDimension(args.canvasCustomHeight, VIEW_H),
    prompt: args.prompt,
    name: args.name,
    createdAt: Date.now(),
  };
}

function normalizePoseBackup(value: unknown): PoseBackup | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, any>;
  if (raw.schema !== POSE_SCHEMA) return null;
  return {
    schema: POSE_SCHEMA,
    version: Number(raw.version) || 3,
    pointVersion: POSE_POINT_VERSION,
    hasPeople: raw.hasPeople !== false,
    presetId: typeof raw.presetId === 'string' ? raw.presetId : 'standing',
    viewId: typeof raw.viewId === 'string' ? raw.viewId : 'front',
    shotId: typeof raw.shotId === 'string' ? raw.shotId : 'full-body',
    intensityId: safeIntensityId(raw.intensityId),
    language: raw.language === 'zh' ? 'zh' : 'en',
    custom: typeof raw.custom === 'string' ? raw.custom : '',
    points: loadPosePoints(raw.points, raw.pointVersion ?? raw.version),
    people: loadPosePeople(raw.people, raw.pointVersion ?? raw.version),
    handControls: safeHandControls(raw.handControls),
    canvasRatioId: safeCanvasRatioId(raw.canvasRatioId),
    canvasCustomWidth: safeCanvasRatioDimension(raw.canvasCustomWidth, VIEW_W),
    canvasCustomHeight: safeCanvasRatioDimension(raw.canvasCustomHeight, VIEW_H),
    prompt: typeof raw.prompt === 'string' ? raw.prompt : '',
    name: typeof raw.name === 'string' ? raw.name : '',
    createdAt: Number(raw.createdAt) || Date.now(),
  };
}

function safePoseFavorites(value: unknown): PoseFavorite[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item, index) => {
      const backup = normalizePoseBackup(item);
      if (!backup) return null;
      const raw = item as Record<string, any>;
      const preset = POSE_PRESETS.find((p) => p.id === backup.presetId);
      return {
        ...backup,
        id: String(raw.id || `pose-fav-${Date.now()}-${index}`),
        name: String(raw.name || preset?.label || `姿势收藏 ${index + 1}`),
        createdAt: Number(raw.createdAt) || Date.now(),
      } as PoseFavorite;
    })
    .filter((item): item is PoseFavorite => !!item)
    .slice(0, MAX_POSE_FAVORITES);
}

function fmt(value: number): string {
  return Number.isFinite(value) ? String(Math.round(value * 10) / 10) : '0';
}

function at(a: PosePoint, b: PosePoint, t: number): PosePoint {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

function distance(a: PosePoint, b: PosePoint): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function unit(a: PosePoint, b: PosePoint): PosePoint {
  const len = distance(a, b) || 1;
  return { x: (b.x - a.x) / len, y: (b.y - a.y) / len };
}

function normal(a: PosePoint, b: PosePoint): PosePoint {
  const dir = unit(a, b);
  return { x: -dir.y, y: dir.x };
}

function offset(point: PosePoint, normalPoint: PosePoint, amount: number): PosePoint {
  return { x: point.x + normalPoint.x * amount, y: point.y + normalPoint.y * amount };
}

function pathPoint(point: PosePoint): string {
  return `${fmt(point.x)} ${fmt(point.y)}`;
}

function angleDeg(a: PosePoint, b: PosePoint): number {
  return (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
}

function segmentContour(a: PosePoint, b: PosePoint, startWidth: number, endWidth: number, fill = '#f8fafc'): string {
  const dir = unit(a, b);
  const n = normal(a, b);
  const aL = offset(a, n, startWidth);
  const aR = offset(a, n, -startWidth);
  const bL = offset(b, n, endWidth);
  const bR = offset(b, n, -endWidth);
  const capA = { x: a.x - dir.x * startWidth * 0.55, y: a.y - dir.y * startWidth * 0.55 };
  const capB = { x: b.x + dir.x * endWidth * 0.55, y: b.y + dir.y * endWidth * 0.55 };
  const contour = `<path d="M ${pathPoint(aL)} L ${pathPoint(bL)} Q ${pathPoint(capB)} ${pathPoint(bR)} L ${pathPoint(aR)} Q ${pathPoint(capA)} ${pathPoint(aL)} Z" fill="${fill}" fill-opacity="0.16" stroke="#5f6670" stroke-width="2.2"/>`;
  const center = `<line x1="${fmt(a.x)}" y1="${fmt(a.y)}" x2="${fmt(b.x)}" y2="${fmt(b.y)}" stroke="#8a949f" stroke-width="1.1" opacity="0.55"/>`;
  const crossLines = [0.36, 0.68]
    .map((t) => {
      const p = at(a, b, t);
      const w = startWidth + (endWidth - startWidth) * t;
      const pL = offset(p, n, w * 0.86);
      const pR = offset(p, n, -w * 0.86);
      return `<line x1="${fmt(pL.x)}" y1="${fmt(pL.y)}" x2="${fmt(pR.x)}" y2="${fmt(pR.y)}" stroke="#8a949f" stroke-width="1" opacity="0.62"/>`;
    })
    .join('');
  return `${contour}${center}${crossLines}`;
}

function handDirectionBasis(wrist: PosePoint, elbow: PosePoint, direction: HandDirection): { forward: PosePoint; spread: PosePoint; arm: PosePoint } {
  const arm = unit(elbow, wrist);
  const side = normal(elbow, wrist);
  let forward = arm;
  if (direction === 'side') forward = side.x < 0 ? side : { x: -side.x, y: -side.y };
  if (direction === 'up') forward = { x: 0, y: -1 };
  if (direction === 'down') forward = { x: 0, y: 1 };
  return {
    forward,
    spread: { x: -forward.y, y: forward.x },
    arm,
  };
}

function handMarkup(wrist: PosePoint, elbow: PosePoint, control?: HandSideControl): string {
  const shape = control?.shape || 'open';
  const direction = control?.direction || 'front';
  const { forward, spread, arm } = handDirectionBasis(wrist, elbow, direction);
  const palm = { x: wrist.x + arm.x * 6 + forward.x * 8, y: wrist.y + arm.y * 6 + forward.y * 8 };
  const angle = (Math.atan2(forward.y, forward.x) * 180) / Math.PI;
  const palmFill = direction === 'front' ? '#f8fafc' : direction === 'side' ? '#dbeafe' : direction === 'up' ? '#ecfccb' : '#fee2e2';
  const fingers = shape === 'fist'
    ? `<circle cx="${fmt(palm.x + forward.x * 9)}" cy="${fmt(palm.y + forward.y * 9)}" r="8" fill="${palmFill}" fill-opacity="0.2" stroke="#5f6670" stroke-width="1.8"/>`
    : shape === 'point'
      ? [-1, 1]
          .map((slot) => {
            const base = offset(palm, spread, slot * 4.2);
            const tip = { x: base.x + forward.x * 15 + spread.x * slot * 0.8, y: base.y + forward.y * 15 + spread.y * slot * 0.8 };
            return `<line x1="${fmt(base.x)}" y1="${fmt(base.y)}" x2="${fmt(tip.x)}" y2="${fmt(tip.y)}" stroke="#5f6670" stroke-width="1.5" stroke-linecap="round"/>`;
          })
          .join('') +
        `<line x1="${fmt(palm.x)}" y1="${fmt(palm.y)}" x2="${fmt(palm.x + forward.x * 25)}" y2="${fmt(palm.y + forward.y * 25)}" stroke="#5f6670" stroke-width="2.2" stroke-linecap="round"/>`
      : [-2, -1, 0, 1, 2]
          .map((slot, index) => {
            const base = offset(palm, spread, slot * 3.1);
            const tip = {
              x: base.x + forward.x * (15 + (index % 2) * 2) + spread.x * slot * 1.5,
              y: base.y + forward.y * (15 + (index % 2) * 2) + spread.y * slot * 1.5,
            };
            return `<line x1="${fmt(base.x)}" y1="${fmt(base.y)}" x2="${fmt(tip.x)}" y2="${fmt(tip.y)}" stroke="#5f6670" stroke-width="1.5" stroke-linecap="round"/>`;
          })
          .join('');
  return `
    <ellipse cx="${fmt(palm.x)}" cy="${fmt(palm.y)}" rx="10" ry="7" transform="rotate(${fmt(angle)} ${fmt(palm.x)} ${fmt(palm.y)})" fill="${palmFill}" fill-opacity="0.16" stroke="#5f6670" stroke-width="2"/>
    ${fingers}
  `;
}

function footMarkup(ankle: PosePoint, foot: PosePoint, knee: PosePoint): string {
  const fallback = distance(ankle, foot) < 4;
  const forward = fallback ? unit(knee, ankle) : unit(ankle, foot);
  const toe = { x: ankle.x + forward.x * 22, y: ankle.y + forward.y * 22 };
  const center = at(ankle, toe, 0.62);
  const angle = angleDeg(ankle, toe);
  const n = normal(ankle, toe);
  const toeLines = [-1.5, 0, 1.5]
    .map((slot) => {
      const start = offset(center, n, slot * 4);
      const end = { x: start.x + forward.x * 10, y: start.y + forward.y * 10 };
      return `<line x1="${fmt(start.x)}" y1="${fmt(start.y)}" x2="${fmt(end.x)}" y2="${fmt(end.y)}" stroke="#8a949f" stroke-width="1" opacity="0.7"/>`;
    })
    .join('');
  return `
    <ellipse cx="${fmt(center.x)}" cy="${fmt(center.y)}" rx="16" ry="7" transform="rotate(${fmt(angle)} ${fmt(center.x)} ${fmt(center.y)})" fill="#f8fafc" fill-opacity="0.16" stroke="#5f6670" stroke-width="2"/>
    ${toeLines}
  `;
}

const OPENPOSE_LIMBS: Array<[JointKey, JointKey, string]> = [
  ['head', 'neck', '#ff3b30'],
  ['neck', 'rShoulder', '#ff9500'],
  ['rShoulder', 'rElbow', '#ffcc00'],
  ['rElbow', 'rWrist', '#34c759'],
  ['neck', 'lShoulder', '#5ac8fa'],
  ['lShoulder', 'lElbow', '#007aff'],
  ['lElbow', 'lWrist', '#5856d6'],
  ['neck', 'chest', '#af52de'],
  ['chest', 'pelvis', '#ff2d55'],
  ['pelvis', 'rHip', '#ff9500'],
  ['rHip', 'rKnee', '#ffcc00'],
  ['rKnee', 'rAnkle', '#34c759'],
  ['rAnkle', 'rFoot', '#30d158'],
  ['pelvis', 'lHip', '#64d2ff'],
  ['lHip', 'lKnee', '#0a84ff'],
  ['lKnee', 'lAnkle', '#5e5ce6'],
  ['lAnkle', 'lFoot', '#bf5af2'],
];

const COCO_JOINTS: JointKey[] = [
  'head',
  'head',
  'head',
  'head',
  'head',
  'lShoulder',
  'rShoulder',
  'lElbow',
  'rElbow',
  'lWrist',
  'rWrist',
  'lHip',
  'rHip',
  'lKnee',
  'rKnee',
  'lAnkle',
  'rAnkle',
];

const COCO_LIMBS: Array<[JointKey, JointKey]> = [
  ['head', 'lShoulder'],
  ['head', 'rShoulder'],
  ['lShoulder', 'rShoulder'],
  ['lShoulder', 'lElbow'],
  ['lElbow', 'lWrist'],
  ['rShoulder', 'rElbow'],
  ['rElbow', 'rWrist'],
  ['lShoulder', 'lHip'],
  ['rShoulder', 'rHip'],
  ['lHip', 'rHip'],
  ['lHip', 'lKnee'],
  ['lKnee', 'lAnkle'],
  ['rHip', 'rKnee'],
  ['rKnee', 'rAnkle'],
];

function openPoseMarkup(points: PosePoints, active: boolean): string {
  const limbs = OPENPOSE_LIMBS.map(
    ([a, b, color]) =>
      `<line x1="${fmt(points[a].x)}" y1="${fmt(points[a].y)}" x2="${fmt(points[b].x)}" y2="${fmt(points[b].y)}" stroke="${color}" stroke-width="${active ? 5 : 4}" stroke-linecap="round" opacity="${active ? 0.95 : 0.56}"/>`,
  ).join('');
  const dots = (Object.keys(points) as JointKey[])
    .map(
      (key) =>
        `<circle cx="${fmt(points[key].x)}" cy="${fmt(points[key].y)}" r="${key === 'head' ? 5 : 6}" fill="#ffffff" stroke="#00f5ff" stroke-width="2" opacity="${active ? 1 : 0.62}"/>`,
    )
    .join('');
  return `<g>${limbs}${dots}</g>`;
}

function cocoMarkup(points: PosePoints, active: boolean): string {
  const limbs = COCO_LIMBS.map(
    ([a, b], index) =>
      `<line x1="${fmt(points[a].x)}" y1="${fmt(points[a].y)}" x2="${fmt(points[b].x)}" y2="${fmt(points[b].y)}" stroke="${index % 2 ? '#2563eb' : '#f97316'}" stroke-width="${active ? 4 : 3}" stroke-linecap="round" opacity="${active ? 0.9 : 0.5}"/>`,
  ).join('');
  const dots = COCO_JOINTS.map((key, index) => {
    const point = points[key];
    return `<g opacity="${active ? 1 : 0.62}"><circle cx="${fmt(point.x)}" cy="${fmt(point.y)}" r="7" fill="#fff7ed" stroke="#ea580c" stroke-width="2"/><text x="${fmt(point.x)}" y="${fmt(point.y + 3)}" text-anchor="middle" font-size="7" fill="#7c2d12" font-family="monospace">${index + 1}</text></g>`;
  }).join('');
  return `<g>${limbs}${dots}</g>`;
}

function poseRenderMarkup(
  person: PosePoints,
  options: { mode: PoseRenderMode; controls?: boolean; handControls?: HandControls },
): string {
  if (options.mode === 'openpose') return openPoseMarkup(person, !!options.controls);
  if (options.mode === 'coco') return cocoMarkup(person, !!options.controls);
  return poseBodyMarkup(person, { controls: options.controls, handControls: options.handControls });
}

function poseBodyMarkup(points: PosePoints, options?: { controls?: boolean; handControls?: HandControls }): string {
  const controls = options?.controls ?? false;
  const joint = controls ? '#22d3ee' : '#8b949e';
  const p = points;
  const torso = `
    <path d="M ${pathPoint(p.lShoulder)}
      Q ${fmt(p.chest.x - 48)} ${fmt(p.chest.y + 12)} ${pathPoint(p.lHip)}
      Q ${fmt(p.pelvis.x)} ${fmt(p.pelvis.y + 34)} ${pathPoint(p.rHip)}
      Q ${fmt(p.chest.x + 48)} ${fmt(p.chest.y + 12)} ${pathPoint(p.rShoulder)}
      Q ${fmt(p.neck.x)} ${fmt(p.neck.y + 12)} ${pathPoint(p.lShoulder)} Z"
      fill="#f8fafc" fill-opacity="0.18" stroke="#5f6670" stroke-width="2.5"/>
    <path d="M ${fmt(p.neck.x)} ${fmt(p.neck.y)} C ${fmt(p.chest.x - 7)} ${fmt(p.chest.y + 24)}, ${fmt(p.pelvis.x - 4)} ${fmt(p.pelvis.y - 38)}, ${fmt(p.pelvis.x)} ${fmt(p.pelvis.y)}" stroke="#8a949f" stroke-width="1.4" opacity="0.7"/>
    <path d="M ${pathPoint(p.lShoulder)} Q ${fmt(p.chest.x)} ${fmt(p.chest.y + 15)} ${pathPoint(p.rShoulder)}" stroke="#8a949f" stroke-width="1.4" opacity="0.7"/>
    <path d="M ${pathPoint(p.lHip)} Q ${fmt(p.pelvis.x)} ${fmt(p.pelvis.y + 17)} ${pathPoint(p.rHip)}" stroke="#8a949f" stroke-width="1.4" opacity="0.7"/>
    <path d="M ${fmt(p.chest.x - 32)} ${fmt(p.chest.y + 24)} Q ${fmt(p.chest.x)} ${fmt(p.chest.y + 35)} ${fmt(p.chest.x + 32)} ${fmt(p.chest.y + 24)}" stroke="#8a949f" stroke-width="1" opacity="0.55"/>
    <path d="M ${fmt(p.pelvis.x - 24)} ${fmt(p.pelvis.y - 35)} Q ${fmt(p.pelvis.x)} ${fmt(p.pelvis.y - 20)} ${fmt(p.pelvis.x + 24)} ${fmt(p.pelvis.y - 35)}" stroke="#8a949f" stroke-width="1" opacity="0.55"/>
  `;
  const neckMarkup = segmentContour(p.neck, p.chest, 7, 9, '#ffffff');
  const headMarkup = `
    <ellipse cx="${fmt(p.head.x)}" cy="${fmt(p.head.y)}" rx="23" ry="34" fill="#f8fafc" fill-opacity="0.12" stroke="#5f6670" stroke-width="2.6"/>
    <path d="M ${fmt(p.head.x - 20)} ${fmt(p.head.y)} Q ${fmt(p.head.x)} ${fmt(p.head.y + 8)} ${fmt(p.head.x + 20)} ${fmt(p.head.y)}" stroke="#8a949f" stroke-width="1.2" opacity="0.75"/>
    <path d="M ${fmt(p.head.x)} ${fmt(p.head.y - 31)} Q ${fmt(p.head.x + 5)} ${fmt(p.head.y)} ${fmt(p.head.x - 3)} ${fmt(p.head.y + 34)}" stroke="#8a949f" stroke-width="1.2" opacity="0.75"/>
  `;
  const limbs = [
    segmentContour(p.lHip, p.lKnee, 13, 11),
    segmentContour(p.lKnee, p.lAnkle, 11, 7),
    footMarkup(p.lAnkle, p.lFoot, p.lKnee),
    segmentContour(p.rHip, p.rKnee, 13, 11),
    segmentContour(p.rKnee, p.rAnkle, 11, 7),
    footMarkup(p.rAnkle, p.rFoot, p.rKnee),
    segmentContour(p.lShoulder, p.lElbow, 10, 8.5),
    segmentContour(p.lElbow, p.lWrist, 8.5, 6.5),
    handMarkup(p.lWrist, p.lElbow, options?.handControls?.left),
    segmentContour(p.rShoulder, p.rElbow, 10, 8.5),
    segmentContour(p.rElbow, p.rWrist, 8.5, 6.5),
    handMarkup(p.rWrist, p.rElbow, options?.handControls?.right),
  ].join('');
  const jointKeys = (Object.keys(points) as JointKey[]).filter((key) => key !== 'head' && key !== 'lFoot' && key !== 'rFoot');
  const jointDots = jointKeys
    .map((key) => `<circle cx="${fmt(points[key].x)}" cy="${fmt(points[key].y)}" r="${key === 'chest' || key === 'pelvis' ? 5 : 6}" fill="${joint}" fill-opacity="${controls ? 0.92 : 0.68}" stroke="#ffffff" stroke-width="1.8"/>`)
    .join('');
  return `
    <g fill="none" stroke-linecap="round" stroke-linejoin="round">
      ${limbs}
      ${torso}
      ${neckMarkup}
      ${headMarkup}
    </g>
    <g>${jointDots}</g>
  `;
}

function poseSvg(
  points: PosePoints,
  options?: {
    controls?: boolean;
    width?: number;
    height?: number;
    people?: PosePoints[];
    handControls?: HandControls;
    mode?: PoseRenderMode;
    canvas?: PoseCanvasBounds;
  },
): string {
  const controls = options?.controls ?? false;
  const width = options?.width ?? VIEW_W;
  const height = options?.height ?? VIEW_H;
  const mode = options?.mode || 'lineart';
  const canvas = options?.canvas || DEFAULT_CANVAS_BOUNDS;
  const people = options?.people !== undefined ? options.people : [points];
  const peopleMarkup = people
    .map((person, index) => `<g opacity="${index === 0 ? 1 : 0.54}">${poseRenderMarkup(person, { mode, controls: controls && index === 0, handControls: options?.handControls })}</g>`)
    .join('');
  const bg = mode === 'openpose' ? '#05070b' : '#ffffff';
  const gridStroke = mode === 'openpose' ? '#334155' : '#e5e7eb';
  return `
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${fmt(canvas.minX)} ${fmt(canvas.minY)} ${fmt(canvas.width)} ${fmt(canvas.height)}">
  <rect x="${fmt(canvas.minX)}" y="${fmt(canvas.minY)}" width="${fmt(canvas.width)}" height="${fmt(canvas.height)}" fill="${bg}"/>
  <defs>
    <pattern id="grid" width="24" height="24" patternUnits="userSpaceOnUse">
      <path d="M24 0H0V24" fill="none" stroke="${gridStroke}" stroke-width="1"/>
    </pattern>
  </defs>
  <rect x="${fmt(canvas.minX)}" y="${fmt(canvas.minY)}" width="${fmt(canvas.width)}" height="${fmt(canvas.height)}" fill="url(#grid)" opacity="${mode === 'openpose' ? 0.36 : 0.45}"/>
  ${peopleMarkup}
</svg>`.trim();
}

async function svgToPngDataUrl(svg: string, width: number, height: number): Promise<string> {
  const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('pose svg render failed'));
      image.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas context unavailable');
    ctx.drawImage(img, 0, 0, width, height);
    return canvas.toDataURL('image/png');
  } finally {
    URL.revokeObjectURL(url);
  }
}

function downloadJson(filename: string, payload: unknown) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

let poseLandmarkerPromise: Promise<PoseLandmarker> | null = null;

function loadHtmlImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const start = (withCrossOrigin: boolean) => {
      const image = new Image();
      if (withCrossOrigin) image.crossOrigin = 'anonymous';
      image.onload = () => {
        if (settled) return;
        settled = true;
        resolve(image);
      };
      image.onerror = () => {
        if (settled) return;
        if (withCrossOrigin) {
          start(false);
          return;
        }
        settled = true;
        reject(new Error('图片载入失败，无法识别姿态'));
      };
      image.src = src;
    };
    start(true);
  });
}

async function getPoseLandmarker(): Promise<PoseLandmarker> {
  if (!poseLandmarkerPromise) {
    poseLandmarkerPromise = (async () => {
      const vision = await FilesetResolver.forVisionTasks(MEDIAPIPE_WASM_BASE);
      return PoseLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath: MEDIAPIPE_POSE_MODEL,
        },
        runningMode: 'IMAGE',
        numPoses: MAX_POSE_PEOPLE,
      });
    })();
  }
  return poseLandmarkerPromise;
}

function mediaPipePoint(landmarks: any[], index: number): PosePoint | null {
  const p = landmarks[index];
  if (!p || typeof p.x !== 'number' || typeof p.y !== 'number') return null;
  return { x: clamp(p.x * VIEW_W, 0, VIEW_W), y: clamp(p.y * VIEW_H, 0, VIEW_H) };
}

function averagePoint(a: PosePoint, b: PosePoint): PosePoint {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function averageAvailablePoints(points: Array<PosePoint | null>): PosePoint | null {
  const valid = points.filter((point): point is PosePoint => !!point);
  if (valid.length === 0) return null;
  return {
    x: valid.reduce((sum, point) => sum + point.x, 0) / valid.length,
    y: valid.reduce((sum, point) => sum + point.y, 0) / valid.length,
  };
}

function attachHeadToNeck(rawHead: PosePoint, neck: PosePoint, pelvis: PosePoint, lShoulder: PosePoint, rShoulder: PosePoint): PosePoint {
  const neckDistance = distance(neck, rawHead);
  const shoulderWidth = distance(lShoulder, rShoulder);
  const torsoLength = distance(neck, pelvis);
  const maxHeadDistance = clamp(Math.max(shoulderWidth * 0.9, torsoLength * 0.34), 30, 92);
  if (neckDistance <= maxHeadDistance) return rawHead;
  const dir = unit(neck, rawHead);
  return {
    x: neck.x + dir.x * maxHeadDistance,
    y: neck.y + dir.y * maxHeadDistance,
  };
}

function mediaPipeLandmarksToPosePoints(landmarks: any[]): PosePoints | null {
  const rawHead = averageAvailablePoints([
    mediaPipePoint(landmarks, 0),
    mediaPipePoint(landmarks, 2),
    mediaPipePoint(landmarks, 5),
    mediaPipePoint(landmarks, 7),
    mediaPipePoint(landmarks, 8),
  ]);
  const lShoulder = mediaPipePoint(landmarks, 11);
  const rShoulder = mediaPipePoint(landmarks, 12);
  const lElbow = mediaPipePoint(landmarks, 13);
  const rElbow = mediaPipePoint(landmarks, 14);
  const lWrist = mediaPipePoint(landmarks, 15);
  const rWrist = mediaPipePoint(landmarks, 16);
  const lHip = mediaPipePoint(landmarks, 23);
  const rHip = mediaPipePoint(landmarks, 24);
  const lKnee = mediaPipePoint(landmarks, 25);
  const rKnee = mediaPipePoint(landmarks, 26);
  const lAnkle = mediaPipePoint(landmarks, 27);
  const rAnkle = mediaPipePoint(landmarks, 28);
  const lFoot = mediaPipePoint(landmarks, 31) || lAnkle;
  const rFoot = mediaPipePoint(landmarks, 32) || rAnkle;
  if (!rawHead || !lShoulder || !rShoulder || !lHip || !rHip) return null;
  const neck = averagePoint(lShoulder, rShoulder);
  const pelvis = averagePoint(lHip, rHip);
  const chest = at(neck, pelvis, 0.42);
  const head = attachHeadToNeck(rawHead, neck, pelvis, lShoulder, rShoulder);
  return constrainFootPoints({
    head,
    neck,
    chest,
    pelvis,
    lShoulder,
    rShoulder,
    lElbow: lElbow || at(lShoulder, lWrist || lShoulder, 0.55),
    rElbow: rElbow || at(rShoulder, rWrist || rShoulder, 0.55),
    lWrist: lWrist || lShoulder,
    rWrist: rWrist || rShoulder,
    lHip,
    rHip,
    lKnee: lKnee || at(lHip, lAnkle || lHip, 0.55),
    rKnee: rKnee || at(rHip, rAnkle || rHip, 0.55),
    lAnkle: lAnkle || lHip,
    rAnkle: rAnkle || rHip,
    lFoot: lFoot || lAnkle || lHip,
    rFoot: rFoot || rAnkle || rHip,
  });
}

async function detectPosePeopleFromImage(src: string): Promise<PosePoints[]> {
  const [landmarker, image] = await Promise.all([getPoseLandmarker(), loadHtmlImage(src)]);
  const result: any = landmarker.detect(image);
  const landmarksList = Array.isArray(result?.landmarks) ? result.landmarks : [];
  return landmarksList
    .map((landmarks: any[]) => mediaPipeLandmarksToPosePoints(landmarks))
    .filter((person: PosePoints | null): person is PosePoints => !!person)
    .slice(0, MAX_POSE_PEOPLE);
}

function posePointKeypoints(points: PosePoints, keys: JointKey[]): number[] {
  return keys.flatMap((key) => [Math.round(points[key].x), Math.round(points[key].y), 1]);
}

function openPoseKeypointsFor(points: PosePoints): number[] {
  const head = points.head;
  const rightEye = { x: head.x + 8, y: head.y - 6 };
  const leftEye = { x: head.x - 8, y: head.y - 6 };
  const rightEar = { x: head.x + 18, y: head.y - 2 };
  const leftEar = { x: head.x - 18, y: head.y - 2 };
  const midHip = points.pelvis;
  const rightToe = points.rFoot;
  const leftToe = points.lFoot;
  const rightHeel = at(points.rAnkle, points.rFoot, 0.2);
  const leftHeel = at(points.lAnkle, points.lFoot, 0.2);
  const list: PosePoint[] = [
    head,
    points.neck,
    points.rShoulder,
    points.rElbow,
    points.rWrist,
    points.lShoulder,
    points.lElbow,
    points.lWrist,
    midHip,
    points.rHip,
    points.rKnee,
    points.rAnkle,
    points.lHip,
    points.lKnee,
    points.lAnkle,
    rightEye,
    leftEye,
    rightEar,
    leftEar,
    leftToe,
    leftToe,
    leftHeel,
    rightToe,
    rightToe,
    rightHeel,
  ];
  return list.flatMap((point) => [Math.round(point.x), Math.round(point.y), 1]);
}

function pointsRelativeToCanvas(points: PosePoints, canvas: PoseCanvasBounds): PosePoints {
  const next = clonePoints(points);
  for (const key of Object.keys(next) as JointKey[]) {
    next[key] = {
      x: points[key].x - canvas.minX,
      y: points[key].y - canvas.minY,
    };
  }
  return next;
}

function buildKeypointsPayload(format: 'openpose' | 'coco', people: PosePoints[], source: string, canvas = DEFAULT_CANVAS_BOUNDS) {
  const relativePeople = people.map((person) => pointsRelativeToCanvas(person, canvas));
  if (format === 'openpose') {
    return {
      schema: KEYPOINT_SCHEMA,
      format,
      version: 1,
      source,
      canvas: { width: Math.round(canvas.width), height: Math.round(canvas.height), ratio: Number(canvas.ratio.toFixed(4)) },
      people: relativePeople.map((person) => ({
        pose_keypoints_2d: openPoseKeypointsFor(person),
        face_keypoints_2d: [],
        hand_left_keypoints_2d: [],
        hand_right_keypoints_2d: [],
      })),
    };
  }
  return {
    schema: KEYPOINT_SCHEMA,
    format,
    version: 1,
    source,
    canvas: { width: Math.round(canvas.width), height: Math.round(canvas.height), ratio: Number(canvas.ratio.toFixed(4)) },
    annotations: relativePeople.map((person, index) => ({
      id: index + 1,
      category_id: 1,
      keypoints: posePointKeypoints(person, COCO_JOINTS),
      num_keypoints: COCO_JOINTS.length,
    })),
  };
}

const PoseMasterNode = (props: NodeProps) => {
  const { id, selected } = props;
  const data = (props.data || {}) as Record<string, any>;
  const rf = useReactFlow();
  const activeId = useCanvasStore((s) => s.activeId);
  const updateNodeData = useUpdateNodeData(id);
  const upstream = useUpstreamMaterials(id);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const draggingRef = useRef<PoseDragState | null>(null);
  const initialPeopleRef = useRef<PosePoints[] | null>(null);
  if (!initialPeopleRef.current) {
    initialPeopleRef.current = loadPosePeople(data.posePeople, data.posePointVersion ?? data.metadata?.pointVersion ?? data.poseMasterMetadata?.pointVersion);
  }

  const [points, setPoints] = useState<PosePoints>(() =>
    initialPeopleRef.current?.[0] ||
    loadPosePoints(data.posePoints, data.posePointVersion ?? data.metadata?.pointVersion ?? data.poseMasterMetadata?.pointVersion),
  );
  const [hasPeople, setHasPeople] = useState<boolean>(() => data.poseHasPeople !== false);
  const [extraPeople, setExtraPeople] = useState<PosePoints[]>(() => initialPeopleRef.current?.slice(1) || []);
  const [activePersonIndex, setActivePersonIndex] = useState<number>(() => clamp(Number(data.poseActivePersonIndex) || 0, 0, MAX_POSE_PEOPLE - 1));
  const [dragMode, setDragMode] = useState<PoseDragMode>(() => (data.poseDragMode === 'body' ? 'body' : 'joint'));
  const [renderMode, setRenderMode] = useState<PoseRenderMode>(() => safeRenderMode(data.poseRenderMode));
  const [canvasRatioId, setCanvasRatioId] = useState<PoseCanvasRatioId>(() => safeCanvasRatioId(data.poseCanvasRatioId));
  const [canvasCustomWidth, setCanvasCustomWidth] = useState<number>(() => safeCanvasRatioDimension(data.poseCanvasCustomWidth, VIEW_W));
  const [canvasCustomHeight, setCanvasCustomHeight] = useState<number>(() => safeCanvasRatioDimension(data.poseCanvasCustomHeight, VIEW_H));
  const [presetId, setPresetId] = useState<string>(() => String(data.posePresetId || 'standing'));
  const [viewId, setViewId] = useState<string>(() => String(data.poseViewId || 'front'));
  const [shotId, setShotId] = useState<string>(() => String(data.poseShotId || 'full-body'));
  const [intensityId, setIntensityId] = useState<string>(() => safeIntensityId(data.poseIntensityId || data.poseIntensity));
  const [language, setLanguage] = useState<Lang>(() => (data.poseLanguage === 'zh' ? 'zh' : 'en'));
  const [custom, setCustom] = useState<string>(() => String(data.poseCustomText || ''));
  const [handControls, setHandControls] = useState<HandControls>(() => safeHandControls(data.poseHandControls || data.handControls));
  const [recognitionImageUrl, setRecognitionImageUrl] = useState<string>(() => String(data.poseRecognitionImageUrl || ''));
  const [suppressedReferenceUrl, setSuppressedReferenceUrl] = useState<string>(() => String(data.poseSuppressedReferenceUrl || ''));
  const [keyframeA, setKeyframeA] = useState<PoseBackup | null>(() => normalizePoseBackup(data.poseKeyframeA) || null);
  const [keyframeB, setKeyframeB] = useState<PoseBackup | null>(() => normalizePoseBackup(data.poseKeyframeB) || null);
  const [keyframeCount, setKeyframeCount] = useState<number>(() => clamp(Math.round(Number(data.poseKeyframeCount)) || 6, 2, 24));
  const [favorites, setFavorites] = useState<PoseFavorite[]>(() => safePoseFavorites(data.poseFavorites));
  const [batchCount, setBatchCount] = useState<number>(() => safeBatchCount(data.poseBatchCount));
  const [batchMode, setBatchMode] = useState<PoseBatchMode>(() => safeBatchMode(data.poseBatchMode));
  const [status, setStatus] = useState<string>('');
  const [recognitionBusy, setRecognitionBusy] = useState(false);

  const upstreamTexts = useMemo(
    () => upstream.texts.map((item) => item.url).filter(Boolean).slice(0, 8),
    [upstream.texts],
  );
  const upstreamImageUrl = upstream.images[0]?.url || '';
  const incomingReferenceImage = recognitionImageUrl || upstreamImageUrl;
  const referenceImage = incomingReferenceImage && incomingReferenceImage !== suppressedReferenceUrl ? incomingReferenceImage : '';
  const posePeople = useMemo(() => (hasPeople ? [points, ...extraPeople].slice(0, MAX_POSE_PEOPLE) : []), [hasPeople, points, extraPeople]);
  const hasClearableContent = posePeople.length > 0 || !!incomingReferenceImage;
  const safeActivePersonIndex = posePeople.length > 0 ? clamp(activePersonIndex, 0, posePeople.length - 1) : 0;
  const activePoints = posePeople[safeActivePersonIndex] || points;
  const poseCanvas = useMemo(
    () => poseCanvasBoundsFor(canvasRatioId, canvasCustomWidth, canvasCustomHeight),
    [canvasRatioId, canvasCustomWidth, canvasCustomHeight],
  );
  const canvasPreviewSize = useMemo(() => poseCanvasPreviewSizeFor(poseCanvas), [poseCanvas]);
  const activePoseBox = useMemo(() => (posePeople.length > 0 ? poseBounds(activePoints) : null), [activePoints, posePeople.length]);
  const activeTransformFrame = useMemo(
    () => (activePoseBox ? poseTransformFrameFor(activePoseBox, poseCanvas) : null),
    [activePoseBox, poseCanvas],
  );
  const renderModeLabel = POSE_RENDER_MODES.find((item) => item.id === renderMode)?.zh || '线稿图';

  const poseOnlyPrompt = useMemo(
    () => buildPosePrompt({ presetId, viewId, shotId, intensityId, language, custom, handControls }),
    [presetId, viewId, shotId, intensityId, language, custom, handControls],
  );

  const prompt = useMemo(
    () => combinePromptParts(upstreamTexts, poseOnlyPrompt, language),
    [upstreamTexts, poseOnlyPrompt, language],
  );

  const metadata = useMemo(
    () => poseMetadata(points, presetId, viewId, shotId, intensityId, language, custom, prompt, { people: posePeople, handControls, canvas: poseCanvas }),
    [points, posePeople, handControls, poseCanvas, presetId, viewId, shotId, intensityId, language, custom, prompt],
  );

  useEffect(() => {
    updateNodeData({
      kind: 'pose-master',
      posePoints: points,
      posePointVersion: POSE_POINT_VERSION,
      poseHasPeople: hasPeople,
      posePresetId: presetId,
      poseDragMode: dragMode,
      poseRenderMode: renderMode,
      poseCanvasRatioId: canvasRatioId,
      poseCanvasCustomWidth: canvasCustomWidth,
      poseCanvasCustomHeight: canvasCustomHeight,
      poseCanvasRatio: poseCanvas.ratio,
      poseViewId: viewId,
      poseShotId: shotId,
      poseIntensityId: intensityId,
      poseLanguage: language,
      poseCustomText: custom,
      poseFavorites: favorites,
      poseBatchCount: batchCount,
      poseBatchMode: batchMode,
      posePeople,
      poseActivePersonIndex: safeActivePersonIndex,
      poseHandControls: handControls,
      poseRecognitionImageUrl: recognitionImageUrl,
      poseSuppressedReferenceUrl: suppressedReferenceUrl,
      poseKeyframeA: keyframeA,
      poseKeyframeB: keyframeB,
      poseKeyframeCount: keyframeCount,
      poseUpstreamTextCount: upstreamTexts.length,
      posePrompt: prompt,
      prompt,
      text: prompt,
      outputText: prompt,
      metadata,
    });
  }, [points, hasPeople, posePeople, safeActivePersonIndex, dragMode, renderMode, canvasRatioId, canvasCustomWidth, canvasCustomHeight, poseCanvas.ratio, handControls, recognitionImageUrl, suppressedReferenceUrl, keyframeA, keyframeB, keyframeCount, presetId, viewId, shotId, intensityId, language, custom, favorites, batchCount, batchMode, upstreamTexts.length, prompt, metadata, updateNodeData]);

  const setActivePosePoints = (updater: PosePoints | ((prev: PosePoints) => PosePoints)) => {
    const nextFor = (prev: PosePoints) => (typeof updater === 'function' ? (updater as (prev: PosePoints) => PosePoints)(prev) : updater);
    if (safeActivePersonIndex <= 0) {
      setPoints((prev) => nextFor(prev));
      return;
    }
    setExtraPeople((prev) =>
      prev.map((person, index) => (index === safeActivePersonIndex - 1 ? nextFor(person) : person)),
    );
  };

  const fitAllPeopleToCanvas = (bounds: PoseCanvasBounds) => {
    setPoints((prev) => fitPosePointsToBounds(prev, bounds));
    setExtraPeople((prev) => prev.map((person) => fitPosePointsToBounds(person, bounds)));
  };

  const applyCanvasRatio = (nextId: PoseCanvasRatioId, nextWidth: unknown = canvasCustomWidth, nextHeight: unknown = canvasCustomHeight) => {
    const safeWidth = safeCanvasRatioDimension(nextWidth, VIEW_W);
    const safeHeight = safeCanvasRatioDimension(nextHeight, VIEW_H);
    setCanvasRatioId(nextId);
    setCanvasCustomWidth(safeWidth);
    setCanvasCustomHeight(safeHeight);
    fitAllPeopleToCanvas(poseCanvasBoundsFor(nextId, safeWidth, safeHeight));
  };

  const toSvgPoint = (event: React.PointerEvent<SVGElement>): PosePoint | null => {
    const svg = svgRef.current;
    if (!svg) return null;
    const rect = svg.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const x = poseCanvas.minX + ((event.clientX - rect.left) / rect.width) * poseCanvas.width;
    const y = poseCanvas.minY + ((event.clientY - rect.top) / rect.height) * poseCanvas.height;
    return clampPointToBounds({ x, y }, poseCanvas);
  };

  const handlePointerDown = (event: React.PointerEvent<SVGCircleElement>, key: JointKey) => {
    if (dragMode === 'body') return;
    event.preventDefault();
    event.stopPropagation();
    draggingRef.current = { mode: 'joint', key };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePoseCanvasPointerDown = (event: React.PointerEvent<SVGSVGElement>) => {
    if (dragMode !== 'body' || posePeople.length === 0) return;
    const point = toSvgPoint(event);
    if (!point) return;
    event.preventDefault();
    draggingRef.current = { mode: 'body', start: point, origin: clonePoints(activePoints), bounds: poseCanvas };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handleTransformPointerDown = (event: React.PointerEvent<SVGCircleElement>, mode: 'scale' | 'rotate') => {
    if (dragMode !== 'body' || posePeople.length === 0 || !activePoseBox) return;
    const point = toSvgPoint(event);
    if (!point) return;
    event.preventDefault();
    event.stopPropagation();
    const center = activePoseBox.center;
    draggingRef.current =
      mode === 'scale'
        ? {
            mode,
            center,
            startDistance: Math.max(1, distance(center, point)),
            origin: clonePoints(activePoints),
            bounds: poseCanvas,
          }
        : {
            mode,
            center,
            startAngle: Math.atan2(point.y - center.y, point.x - center.x),
            origin: clonePoints(activePoints),
            bounds: poseCanvas,
          };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: React.PointerEvent<SVGSVGElement>) => {
    const drag = draggingRef.current;
    if (!drag) return;
    const point = toSvgPoint(event);
    if (!point) return;
    if (drag.mode === 'body') {
      setActivePosePoints(translatePosePoints(drag.origin, point.x - drag.start.x, point.y - drag.start.y, drag.bounds));
      return;
    }
    if (drag.mode === 'scale') {
      setActivePosePoints(scalePosePoints(drag.origin, drag.center, Math.max(1, distance(drag.center, point)) / drag.startDistance, drag.bounds));
      return;
    }
    if (drag.mode === 'rotate') {
      const nextAngle = Math.atan2(point.y - drag.center.y, point.x - drag.center.x);
      setActivePosePoints(rotatePosePoints(drag.origin, drag.center, nextAngle - drag.startAngle, drag.bounds));
      return;
    }
    const key = drag.key;
    setActivePosePoints((prev) => {
      const next = { ...prev, [key]: constrainFootPoint(key, point, prev, poseCanvas) };
      if (key === 'lAnkle') next.lFoot = constrainFootPoint('lFoot', next.lFoot, next, poseCanvas);
      if (key === 'rAnkle') next.rFoot = constrainFootPoint('rFoot', next.rFoot, next, poseCanvas);
      return next;
    });
  };

  const stopDragging = () => {
    draggingRef.current = null;
  };

  const applyPreset = (nextPresetId: string) => {
    const preset = POSE_PRESETS.find((item) => item.id === nextPresetId) || POSE_PRESETS[0];
    setPresetId(preset.id);
    setHasPeople(true);
    setActivePosePoints(fitPosePointsToBounds(clonePoints(preset.points), poseCanvas));
  };

  const currentBackup = (name?: string) =>
    makePoseBackup({
      points,
      people: posePeople,
      hasPeople,
      handControls,
      presetId,
      viewId,
      shotId,
      intensityId,
      language,
      custom,
      prompt,
      name,
      canvasRatioId,
      canvasCustomWidth,
      canvasCustomHeight,
    });

  const applyBackup = (backup: PoseBackup) => {
    const nextCanvasRatioId = safeCanvasRatioId(backup.canvasRatioId);
    const nextCanvasCustomWidth = safeCanvasRatioDimension(backup.canvasCustomWidth, VIEW_W);
    const nextCanvasCustomHeight = safeCanvasRatioDimension(backup.canvasCustomHeight, VIEW_H);
    const nextCanvas = poseCanvasBoundsFor(nextCanvasRatioId, nextCanvasCustomWidth, nextCanvasCustomHeight);
    const people = backup.hasPeople === false ? [] : backup.people && backup.people.length > 0 ? backup.people.map(clonePoints) : [clonePoints(backup.points)];
    const fittedPeople = people.map((person) => fitPosePointsToBounds(person, nextCanvas));
    setCanvasRatioId(nextCanvasRatioId);
    setCanvasCustomWidth(nextCanvasCustomWidth);
    setCanvasCustomHeight(nextCanvasCustomHeight);
    setHasPeople(fittedPeople.length > 0);
    setPoints(fittedPeople[0] || fitPosePointsToBounds(clonePoints(backup.points), nextCanvas));
    setExtraPeople(fittedPeople.slice(1, MAX_POSE_PEOPLE));
    setActivePersonIndex(0);
    setHandControls(safeHandControls(backup.handControls));
    setPresetId(backup.presetId || 'standing');
    setViewId(backup.viewId || 'front');
    setShotId(backup.shotId || 'full-body');
    setIntensityId(safeIntensityId(backup.intensityId));
    setLanguage(backup.language === 'zh' ? 'zh' : 'en');
    setCustom(backup.custom || '');
  };

  const saveFavorite = () => {
    const preset = POSE_PRESETS.find((item) => item.id === presetId);
    const intensity = POSE_INTENSITY_OPTIONS.find((item) => item.id === intensityId);
    const name = `${preset?.label || '姿势'} · ${intensity?.zh || '自然'}`;
    const fav: PoseFavorite = {
      ...currentBackup(name),
      id: `pose-fav-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name,
      createdAt: Date.now(),
    };
    setFavorites((prev) => [fav, ...prev.filter((item) => item.name !== fav.name)].slice(0, MAX_POSE_FAVORITES));
    setStatus('已收藏当前姿势');
  };

  const handleSaveToResourceLibrary = async () => {
    const preset = POSE_PRESETS.find((item) => item.id === presetId);
    const shot = SHOT_OPTIONS.find((item) => item.id === shotId);
    const name = `${preset?.label || '姿势'} · ${shot?.zh || '姿势大师'}`.slice(0, 80);
    try {
      let categoryId = 'pose_uncategorized';
      const cats = await api.getResourceCategories('pose');
      if (cats.success) {
        const existing = cats.data.find((cat) => cat.name === '常用姿势' || cat.name === '姿势大师');
        if (existing) categoryId = existing.id;
        else {
          const created = await api.addResourceCategory('pose', '常用姿势');
          if (created.success) categoryId = created.data.id;
        }
      }
      const saved = await api.addResourcePose({
        poseBackup: currentBackup(name),
        categoryId,
        title: `${name} · 姿势配置`,
        tags: ['pose-master', '姿势大师', '姿态'],
        sourceNodeId: id,
        sourceCanvasId: activeId || '',
        favorite: true,
      });
      if (!saved.success) throw new Error(saved.error || '保存资源库失败');
      window.dispatchEvent(new CustomEvent('penguin:resources-changed'));
      const message = (saved as any).duplicate ? '资源库已有相同姿势配置' : '已保存到资源库姿势分类';
      setStatus(message);
      logBus.success(message, '姿势大师');
    } catch (e: any) {
      const message = e?.message || '保存到资源库失败';
      setStatus(message);
      logBus.warn(message, '姿势大师');
    }
  };

  const removeFavorite = (favId: string) => {
    setFavorites((prev) => prev.filter((item) => item.id !== favId));
  };

  const exportPoseLibrary = () => {
    downloadJson(`t8-pose-master-library-${Date.now()}.json`, {
      schema: POSE_LIBRARY_SCHEMA,
      version: 1,
      exportedAt: new Date().toISOString(),
      current: currentBackup('当前姿势'),
      favorites,
    });
  };

  const buildPromptForSnapshot = (snapshot: {
    presetId: string;
    viewId: string;
    shotId: string;
    intensityId: string;
    language: Lang;
    custom: string;
    handControls?: HandControls;
  }) => {
    const poseText = buildPosePrompt(snapshot);
    return combinePromptParts(upstreamTexts, poseText, snapshot.language);
  };

  const renderPoseOutput = async (snapshot: PoseBackup, mode: PoseRenderMode = renderMode) => {
    const snapshotPrompt = buildPromptForSnapshot(snapshot);
    const snapshotCanvas = poseCanvasBoundsFor(
      safeCanvasRatioId(snapshot.canvasRatioId || canvasRatioId),
      safeCanvasRatioDimension(snapshot.canvasCustomWidth ?? canvasCustomWidth, VIEW_W),
      safeCanvasRatioDimension(snapshot.canvasCustomHeight ?? canvasCustomHeight, VIEW_H),
    );
    const outputSize = poseOutputSizeFor(snapshotCanvas);
    const snapshotPeople = (snapshot.hasPeople === false
      ? []
      : snapshot.people && snapshot.people.length > 0
        ? snapshot.people
        : [snapshot.points]).map((person) => fitPosePointsToBounds(person, snapshotCanvas));
    const snapshotPoints = snapshotPeople[0] || fitPosePointsToBounds(snapshot.points, snapshotCanvas);
    const snapshotMetadata = poseMetadata(
      snapshotPoints,
      snapshot.presetId,
      snapshot.viewId,
      snapshot.shotId,
      snapshot.intensityId,
      snapshot.language,
      snapshot.custom,
      snapshotPrompt,
      {
        people: snapshotPeople,
        handControls: snapshot.handControls || handControls,
        canvas: snapshotCanvas,
      },
    );
    const svg = poseSvg(snapshotPoints, {
      controls: false,
      width: outputSize.width,
      height: outputSize.height,
      people: snapshotPeople,
      handControls: snapshot.handControls || handControls,
      mode,
      canvas: snapshotCanvas,
    });
    const pngDataUrl = await svgToPngDataUrl(svg, outputSize.width, outputSize.height);
    const imageUrl = await uploadDataUrl(pngDataUrl, 'pose-master');
    return { imageUrl, prompt: snapshotPrompt, metadata: snapshotMetadata };
  };

  const writePoseOutputs = (items: Array<{ imageUrl: string; prompt: string; metadata: ReturnType<typeof poseMetadata> }>, successText: string) => {
    if (items.length === 0) return;
    const imageUrls = items.map((item) => item.imageUrl);
    const prompts = items.map((item) => item.prompt);
    const allMetadata = items.map((item) => item.metadata);
    const joinedPrompt = prompts.join('\n\n');
    const nextData = {
      imageUrl: imageUrls[0],
      imageUrls,
      urls: imageUrls,
      directImageUrl: imageUrls[0],
      directImageUrls: imageUrls,
      directOutputText: joinedPrompt,
      directTextSegments: prompts,
      textSegments: prompts,
      texts: prompts,
      prompt: joinedPrompt,
      text: joinedPrompt,
      outputText: joinedPrompt,
      posePrompt: joinedPrompt,
      poseRenderMode: renderMode,
      metadata: allMetadata[0],
      poseMasterMetadata: items.length === 1 ? allMetadata[0] : allMetadata,
      status: 'success',
      taskStatus: 'completed',
      isRunning: false,
      runError: '',
    };
    updateNodeData(nextData);

    const nodes = rf.getNodes();
    const edges = rf.getEdges();
    const downstreamOutputNodes = edges
      .filter((edge) => edge.source === id)
      .map((edge) => nodes.find((node) => node.id === edge.target))
      .filter((node): node is NonNullable<typeof node> => !!node && node.type === 'output');
    const managedOutputNodes = downstreamOutputNodes.filter((node) =>
      String(node.id).startsWith(`output-auto-pose-master-${id}-`) || (node.data as any)?.poseMasterSourceId === id,
    );
    const legacySplitOutputNodes = downstreamOutputNodes.filter((node) =>
      String(node.id).startsWith(`output-auto-${id}-`) && (node.data as any)?.poseMasterSourceId !== id,
    );
    const targetOutput =
      managedOutputNodes[0] ||
      downstreamOutputNodes.find((node) => !legacySplitOutputNodes.some((legacy) => legacy.id === node.id)) ||
      legacySplitOutputNodes[0];
    const removableAutoIds = new Set(
      [...managedOutputNodes, ...legacySplitOutputNodes]
        .filter((node) => node.id !== targetOutput?.id)
        .map((node) => node.id),
    );
    const outputData = {
      title: items.length > 1 ? '姿势分镜合集' : '姿势参考',
      directImageUrl: imageUrls[0],
      directImageUrls: imageUrls,
      imageUrl: imageUrls[0],
      imageUrls,
      urls: imageUrls,
      directOutputText: joinedPrompt,
      directTextSegments: prompts,
      textSegments: prompts,
      texts: prompts,
      prompt: joinedPrompt,
      text: joinedPrompt,
      outputText: joinedPrompt,
      poseMasterSourceId: id,
      poseMasterRenderMode: renderMode,
      poseMasterOutputMode: items.length > 1 ? 'collection' : 'single',
      poseMasterMetadata: items.length === 1 ? allMetadata[0] : allMetadata,
      updatedAt: Date.now(),
    };

    if (targetOutput) {
      rf.setNodes((current) =>
        current
          .filter((node) => !removableAutoIds.has(node.id))
          .map((node) =>
            node.id === targetOutput.id
              ? {
                  ...node,
                  data: {
                    ...(node.data || {}),
                    ...outputData,
                  },
                }
              : node,
          ),
      );
      if (removableAutoIds.size > 0) {
        rf.setEdges((current) => current.filter((edge) => !removableAutoIds.has(edge.source) && !removableAutoIds.has(edge.target)));
      }
    } else {
      const self = nodes.find((node) => node.id === id);
      const baseX = (self?.position.x || 0) + 940;
      const baseY = self?.position.y || 0;
      const pos = placeSingleNode(baseX, baseY, 'output', nodes, { source: `placement:pose-master-output:${id}` });
      const ts = Date.now();
      const newId = `output-auto-pose-master-${id}-${ts}-${Math.random().toString(36).slice(2, 6)}`;
      rf.addNodes({
        id: newId,
        type: 'output',
        position: pos,
        data: {
          ...outputData,
          updatedAt: ts,
        },
      });
      rf.addEdges({
        id: `e-auto-pose-master-${newId}`,
        source: id,
        target: newId,
        type: 'smoothstep',
      });
    }
    setStatus(successText);
  };

  const runPose = async () => {
    const modeLabel = POSE_RENDER_MODES.find((item) => item.id === renderMode)?.zh || '姿势参考';
    setStatus(`生成${modeLabel}中...`);
    updateNodeData({ status: 'running', taskStatus: 'running', isRunning: true, runError: '', error: '' });
    try {
      const item = await renderPoseOutput(currentBackup('当前姿势'));
      writePoseOutputs([item], `已输出${modeLabel}和 prompt`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus(message || '输出失败');
      updateNodeData({ status: 'error', taskStatus: 'failed', isRunning: false, runError: message || '输出失败', error: message || '输出失败' });
      throw error;
    }
  };

  const buildBatchBackups = (): PoseBackup[] => {
    if (batchMode === 'current') {
      return Array.from({ length: batchCount }, (_, index) => currentBackup(`当前姿势 ${index + 1}`));
    }
    const currentIndex = Math.max(0, POSE_PRESETS.findIndex((item) => item.id === presetId));
    const used = new Set<string>();
    return Array.from({ length: batchCount }, (_, index) => {
      let preset: PosePreset;
      if (batchMode === 'random') {
        const pool = POSE_PRESETS.filter((item) => !used.has(item.id));
        preset = pool.length > 0 ? pool[Math.floor(Math.random() * pool.length)] : POSE_PRESETS[Math.floor(Math.random() * POSE_PRESETS.length)];
      } else {
        preset = POSE_PRESETS[(currentIndex + index) % POSE_PRESETS.length];
      }
      used.add(preset.id);
      return makePoseBackup({
        points: preset.points,
        hasPeople: true,
        handControls,
        presetId: preset.id,
        viewId,
        shotId,
        intensityId,
        language,
        custom,
        canvasRatioId,
        canvasCustomWidth,
        canvasCustomHeight,
        name: `${preset.label} ${index + 1}`,
      });
    });
  };

  const runBatchPose = async () => {
    const modeLabel = POSE_RENDER_MODES.find((item) => item.id === renderMode)?.zh || '姿势图';
    setStatus(`批量生成 ${batchCount} 个${modeLabel}中...`);
    updateNodeData({ status: 'running', taskStatus: 'running', isRunning: true, runError: '', error: '' });
    try {
      const snapshots = buildBatchBackups();
      const items = [];
      for (const snapshot of snapshots) {
        items.push(await renderPoseOutput(snapshot));
      }
      writePoseOutputs(items, `已批量输出 ${items.length} 个${modeLabel}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus(message || '批量输出失败');
      updateNodeData({ status: 'error', taskStatus: 'failed', isRunning: false, runError: message || '批量输出失败', error: message || '批量输出失败' });
      throw error;
    }
  };

  const requestPoseMasterRun = (mode: PoseMasterRunMode) => {
    const requestId = createCanvasNodeRunRequestId(id, `pose-master-${mode}`);
    updateNodeData({ poseMasterRunMode: mode, poseMasterRunRequestId: requestId });
    window.requestAnimationFrame(() => {
      if (requestCanvasNodeRun(id, { requestId })) return;
      const liveData = rf.getNode(id)?.data as Record<string, unknown> | undefined;
      if (liveData?.poseMasterRunRequestId !== requestId) return;
      updateNodeData({
        poseMasterRunMode: 'single',
        poseMasterRunRequestId: '',
        status: 'error',
        taskStatus: 'failed',
        error: '无法提交画布运行请求，请重试。',
      });
    });
  };

  useRunTrigger(id, async (reporter) => {
    const liveData = rf.getNode(id)?.data as Record<string, unknown> | undefined;
    const contextRequestId = String(reporter.runContext?.requestId || '').trim();
    const persistedRequestId = String(liveData?.poseMasterRunRequestId || '').trim();
    const requestedMode = String(persistedRequestId ? liveData?.poseMasterRunMode || 'single' : 'single') as PoseMasterRunMode;
    try {
      if (persistedRequestId && contextRequestId !== persistedRequestId) {
        throw new Error('姿势大师运行请求已过期或被修改，已停止输出。');
      }
      switch (requestedMode) {
        case 'single':
          await runPose();
          break;
        case 'batch':
          await runBatchPose();
          break;
        case 'keyframes':
          await runKeyframeSequence();
          break;
        default:
          throw new Error('姿势大师运行模式无效，已停止输出。');
      }
    } finally {
      if (contextRequestId) {
        const latestData = rf.getNode(id)?.data as Record<string, unknown> | undefined;
        if (latestData?.poseMasterRunRequestId === contextRequestId) {
          updateNodeData({ poseMasterRunMode: 'single', poseMasterRunRequestId: '' });
        }
      }
    }
  }, 'pose-master', { lifecycleAware: true });

  const addPerson = () => {
    if (posePeople.length >= MAX_POSE_PEOPLE) {
      setStatus(`最多支持 ${MAX_POSE_PEOPLE} 人姿态`);
      return;
    }
    if (posePeople.length === 0) {
      setPoints(shiftPosePoints(DEFAULT_POINTS, VIEW_X_OFFSET, 0, poseCanvas));
      setExtraPeople([]);
      setHasPeople(true);
      setActivePersonIndex(0);
      setStatus('已添加一个人物姿态');
      return;
    }
    setExtraPeople((prev) => {
      const offset = 24 * (prev.length + 1);
      const shifted = shiftPosePoints(activePoints, offset, 0, poseCanvas);
      return [...prev, shifted].slice(0, MAX_POSE_PEOPLE - 1);
    });
    setActivePersonIndex(posePeople.length);
    setStatus('已添加一个人物姿态');
  };

  const duplicatePerson = () => {
    if (posePeople.length === 0) {
      addPerson();
      return;
    }
    if (posePeople.length >= MAX_POSE_PEOPLE) {
      setStatus(`最多支持 ${MAX_POSE_PEOPLE} 人姿态`);
      return;
    }
    setExtraPeople((prev) => [...prev, shiftPosePoints(activePoints, 24 * (prev.length + 1), 0, poseCanvas)].slice(0, MAX_POSE_PEOPLE - 1));
    setActivePersonIndex(posePeople.length);
    setStatus('已复制当前人物姿态');
  };

  const removePerson = () => {
    if (posePeople.length <= 1) {
      setHasPeople(false);
      setExtraPeople([]);
      setActivePersonIndex(0);
      setStatus('已清空最后一个人物姿态');
      return;
    }
    if (safeActivePersonIndex === 0) {
      const [firstExtra, ...rest] = extraPeople;
      setPoints(firstExtra ? clonePoints(firstExtra) : clonePoints(DEFAULT_POINTS));
      setExtraPeople(rest);
      setActivePersonIndex(0);
    } else {
      setExtraPeople((prev) => prev.filter((_, index) => index !== safeActivePersonIndex - 1));
      setActivePersonIndex(Math.max(0, safeActivePersonIndex - 1));
    }
    setStatus('已删除当前人物姿态');
  };

  const clearPeople = () => {
    setHasPeople(false);
    setExtraPeople([]);
    setActivePersonIndex(0);
    setRecognitionImageUrl('');
    if (upstreamImageUrl || recognitionImageUrl) {
      setSuppressedReferenceUrl(upstreamImageUrl || recognitionImageUrl);
      setStatus('已清空姿态画布和当前参考背景；重新识别上游或导入图片可恢复背景');
    } else {
      setSuppressedReferenceUrl('');
      setStatus('已清空姿态画布，可重新添加人物');
    }
  };

  const exportKeypoints = (format: 'openpose' | 'coco') => {
    downloadJson(`t8-pose-master-${format}-${Date.now()}.json`, buildKeypointsPayload(format, posePeople, id, poseCanvas));
    setStatus(`已导出 ${format === 'openpose' ? 'OpenPose' : 'COCO'} keypoints JSON`);
  };

  const applyDetectedPosePeople = (people: PosePoints[], sourceLabel: string) => {
    const fittedPeople = people.slice(0, MAX_POSE_PEOPLE).map((person) => fitPosePointsToBounds(person, poseCanvas));
    setHasPeople(true);
    setPoints(clonePoints(fittedPeople[0]));
    setExtraPeople(fittedPeople.slice(1).map(clonePoints));
    setActivePersonIndex(0);
    setStatus(`已从${sourceLabel}识别 ${fittedPeople.length} 人，可切换线稿 / OpenPose / COCO 预览或运行输出`);
  };

  const recognizePoseFromImageUrl = async (imageUrl: string, sourceLabel: string, options?: { rememberReference?: boolean }) => {
    if (!imageUrl) {
      setStatus('请先把图片连到左侧 image 输入，或导入本地图片');
      return;
    }
    setRecognitionBusy(true);
    setStatus(`正在识别${sourceLabel}姿态...`);
    setSuppressedReferenceUrl('');
    updateNodeData({ isRunning: true, runError: '' });
    try {
      if (options?.rememberReference || sourceLabel === '上游图') setRecognitionImageUrl(imageUrl);
      logBus.info(`开始识别${sourceLabel}姿态`, '姿势大师');
      const people = await detectPosePeopleFromImage(imageUrl);
      if (people.length === 0) {
        const message = `未从${sourceLabel}识别到人物姿态，已保留参考图；可先切回线稿图作为淡底参考手动调整`;
        setStatus(message);
        logBus.warn(message, '姿势大师');
        updateNodeData({ isRunning: false, runError: message });
        return;
      }
      applyDetectedPosePeople(people, sourceLabel);
      logBus.success(`已从${sourceLabel}识别 ${people.length} 人姿态`, '姿势大师');
      updateNodeData({ isRunning: false, runError: '' });
    } catch (error) {
      const message = error instanceof Error ? error.message : '姿态识别失败';
      setStatus(message);
      logBus.warn(message, '姿势大师');
      updateNodeData({ isRunning: false, runError: message });
    } finally {
      setRecognitionBusy(false);
    }
  };

  const handleImportPoseImage = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
      const imageUrl = await uploadFileBlob(file, `pose-reference-${Date.now()}-${file.name || 'image.png'}`);
      await recognizePoseFromImageUrl(imageUrl, '本地图', { rememberReference: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : '姿态识别失败';
      setStatus(message);
      updateNodeData({ isRunning: false, runError: message });
    }
  };

  const saveKeyframe = (key: 'A' | 'B') => {
    const backup = currentBackup(`关键帧 ${key}`);
    if (key === 'A') setKeyframeA(backup);
    else setKeyframeB(backup);
    setStatus(`已保存关键帧 ${key}`);
  };

  const buildKeyframeBackups = (): PoseBackup[] => {
    if (!keyframeA || !keyframeB) return [];
    const aPeople = keyframeA.people && keyframeA.people.length > 0 ? keyframeA.people : [keyframeA.points];
    const bPeople = keyframeB.people && keyframeB.people.length > 0 ? keyframeB.people : [keyframeB.points];
    const peopleCount = Math.min(MAX_POSE_PEOPLE, Math.max(aPeople.length, bPeople.length));
    const count = clamp(Math.round(Number(keyframeCount)) || 6, 2, 24);
    return Array.from({ length: count }, (_, index) => {
      const t = count === 1 ? 0 : index / (count - 1);
      const people = Array.from({ length: peopleCount }, (_, personIndex) => {
        const a = aPeople[personIndex] || aPeople[0] || points;
        const b = bPeople[personIndex] || bPeople[0] || points;
        return interpolatePoints(a, b, t);
      });
      return makePoseBackup({
        points: people[0],
        people,
        handControls,
        presetId,
        viewId,
        shotId,
        intensityId,
        language,
        custom: custom ? `${custom} keyframe ${index + 1}/${count}` : `keyframe ${index + 1}/${count}`,
        canvasRatioId,
        canvasCustomWidth,
        canvasCustomHeight,
        name: `关键帧 ${index + 1}`,
      });
    });
  };

  const runKeyframeSequence = async () => {
    const snapshots = buildKeyframeBackups();
    if (snapshots.length === 0) {
      const message = '请先保存 A / B 两个关键帧';
      setStatus(message);
      updateNodeData({ status: 'error', taskStatus: 'failed', isRunning: false, runError: message, error: message });
      throw new Error(message);
    }
    setStatus(`正在输出 ${snapshots.length} 帧姿态序列...`);
    updateNodeData({ status: 'running', taskStatus: 'running', isRunning: true, runError: '', error: '' });
    try {
      const items = [];
      for (const snapshot of snapshots) items.push(await renderPoseOutput(snapshot));
      writePoseOutputs(items, `已输出 ${items.length} 帧关键帧姿态合集`);
    } catch (error) {
      const message = error instanceof Error ? error.message : '关键帧输出失败';
      setStatus(message);
      updateNodeData({ status: 'error', taskStatus: 'failed', isRunning: false, runError: message, error: message });
      throw error;
    }
  };

  const handleImportJson = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result || '{}'));
        if (parsed?.schema === POSE_LIBRARY_SCHEMA) {
          const current = normalizePoseBackup(parsed.current);
          const importedFavorites = safePoseFavorites(parsed.favorites);
          if (current) applyBackup(current);
          if (importedFavorites.length > 0) {
            setFavorites((prev) => {
              const merged = [...importedFavorites, ...prev];
              const seen = new Set<string>();
              return merged
                .filter((item) => {
                  const key = `${item.name}:${item.presetId}:${item.viewId}:${item.shotId}:${item.intensityId}:${JSON.stringify(item.points)}`;
                  if (seen.has(key)) return false;
                  seen.add(key);
                  return true;
                })
                .slice(0, MAX_POSE_FAVORITES);
            });
          }
          setStatus(`已导入姿势库${importedFavorites.length ? ` · 收藏 ${importedFavorites.length}` : ''}`);
          return;
        }
        const backup = normalizePoseBackup(parsed);
        if (!backup) throw new Error('不是姿势大师 JSON');
        applyBackup(backup);
        setStatus('已导入姿势 JSON');
      } catch (error) {
        setStatus(error instanceof Error ? error.message : '导入失败');
      }
    };
    reader.readAsText(file, 'utf-8');
  };

  return (
    <div
      className={[
        't8-node relative w-[1220px] overflow-visible rounded-[var(--t8-radius-lg)] border border-[var(--t8-border)] bg-[var(--t8-node-bg)] text-[var(--t8-text)] shadow-[var(--t8-node-shadow)]',
        selected ? 'ring-2 ring-[var(--t8-accent)]' : '',
      ].join(' ')}
      data-node-kind="pose-master"
    >
      <Handle
        type="target"
        position={Position.Left}
        style={{ background: PORT_COLOR.text }}
        className="t8-port"
      />
      <Handle
        type="source"
        position={Position.Right}
        style={{ background: PORT_COLOR.image }}
        className="t8-port"
      />

      <div className="t8-node-header flex items-center justify-between gap-3 border-b border-[var(--t8-border)] px-4 py-3">
        <div className="flex items-center gap-3">
          <div className="t8-icon-box">
            <PersonStanding size={20} />
          </div>
          <div>
            <div className="text-lg font-bold leading-tight">姿势大师</div>
            <div className="text-xs text-[var(--t8-text-muted)]">
              线稿姿态 / 识别 / Keypoints · {language === 'en' ? 'EN prompt' : '中文 prompt'}
            </div>
          </div>
        </div>
        <button
          type="button"
          className="t8-mini-icon-button nodrag nopan"
          title="重置为当前预设"
          onClick={() => applyPreset(presetId)}
        >
          <RotateCcw size={16} />
        </button>
      </div>

      <div className="grid grid-cols-[720px_1fr] gap-3 p-4">
        <section className="t8-card p-3">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="text-sm font-semibold">姿态线稿</div>
              <div className="text-[11px] text-[var(--t8-text-muted)]">
                {dragMode === 'body' ? '抓取：移动 / 等比缩放 / 旋转' : '骨骼：拖动关节点调整'}
              </div>
            </div>
            <div className="flex flex-wrap items-center justify-end gap-1.5 text-[11px] text-[var(--t8-text-muted)]">
              <span className="font-semibold">画布</span>
              <select
                className="t8-input nodrag nopan h-8 w-24 px-2 text-xs"
                value={canvasRatioId}
                onChange={(event) => applyCanvasRatio(safeCanvasRatioId(event.target.value))}
              >
                {POSE_CANVAS_RATIOS.map((ratio) => (
                  <option key={ratio.id} value={ratio.id}>
                    {ratio.label}
                  </option>
                ))}
              </select>
              {canvasRatioId === 'custom' ? (
                <>
                  <input
                    className="t8-input nodrag nopan h-8 w-14 px-1 text-center text-xs tabular-nums"
                    type="number"
                    min={1}
                    max={9999}
                    value={canvasCustomWidth}
                    onChange={(event) => applyCanvasRatio('custom', event.target.value, canvasCustomHeight)}
                  />
                  <span>:</span>
                  <input
                    className="t8-input nodrag nopan h-8 w-14 px-1 text-center text-xs tabular-nums"
                    type="number"
                    min={1}
                    max={9999}
                    value={canvasCustomHeight}
                    onChange={(event) => applyCanvasRatio('custom', canvasCustomWidth, event.target.value)}
                  />
                </>
              ) : null}
            </div>
          </div>
          <div
            className="flex items-center justify-center overflow-hidden rounded-[var(--t8-radius)] border border-[var(--t8-border)] bg-[var(--t8-bg-panel-muted)] p-2 transition-[height]"
            style={{ height: `${canvasPreviewSize.height + POSE_CANVAS_FRAME_PADDING}px` }}
          >
            <svg
              ref={svgRef}
              className="nodrag nopan block select-none rounded-[calc(var(--t8-radius)-2px)] border border-[var(--t8-border)] shadow-sm"
              style={{
                aspectRatio: `${poseCanvas.width} / ${poseCanvas.height}`,
                width: `${canvasPreviewSize.width}px`,
                height: `${canvasPreviewSize.height}px`,
                maxWidth: '100%',
                maxHeight: '100%',
              }}
              viewBox={`${poseCanvas.minX} ${poseCanvas.minY} ${poseCanvas.width} ${poseCanvas.height}`}
              onPointerDown={handlePoseCanvasPointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={stopDragging}
              onPointerCancel={stopDragging}
            >
              <defs>
                <pattern id={`pose-grid-${id}`} width="24" height="24" patternUnits="userSpaceOnUse">
                  <path d="M24 0H0V24" fill="none" stroke={renderMode === 'openpose' ? '#334155' : '#e5e7eb'} strokeWidth="1" />
                </pattern>
              </defs>
              <rect x={poseCanvas.minX} y={poseCanvas.minY} width={poseCanvas.width} height={poseCanvas.height} fill={renderMode === 'openpose' ? '#05070b' : '#fff'} />
              <rect x={poseCanvas.minX} y={poseCanvas.minY} width={poseCanvas.width} height={poseCanvas.height} fill={`url(#pose-grid-${id})`} opacity={renderMode === 'openpose' ? 0.36 : 0.45} />
              {renderMode === 'lineart' && referenceImage ? (
                <image
                  href={referenceImage}
                  x={poseCanvas.minX + 28}
                  y={poseCanvas.minY + 16}
                  width={Math.max(1, poseCanvas.width - 56)}
                  height={Math.max(1, poseCanvas.height - 32)}
                  preserveAspectRatio="xMidYMid meet"
                  opacity={0.18}
                />
              ) : null}
              {posePeople.map((person, index) => (
                <g
                  key={`person-${index}`}
                  opacity={index === safeActivePersonIndex ? 1 : 0.42}
                  dangerouslySetInnerHTML={{
                    __html: poseRenderMarkup(person, {
                      mode: renderMode,
                      controls: index === safeActivePersonIndex,
                      handControls,
                    }),
                  }}
                />
              ))}
              {posePeople.length > 0 ? (Object.keys(activePoints) as JointKey[]).map((key) => (
                <g key={key}>
                  <circle
                    cx={activePoints[key].x}
                    cy={activePoints[key].y}
                    r={key === 'head' ? 5 : 6}
                    fill="#22d3ee"
                    stroke="#fff"
                    strokeWidth="2"
                  />
                  <circle
                    className="cursor-grab active:cursor-grabbing"
                    cx={activePoints[key].x}
                    cy={activePoints[key].y}
                    r={15}
                    fill="transparent"
                    onPointerDown={(event) => handlePointerDown(event, key)}
                  />
                </g>
              )) : null}
              {dragMode === 'body' && activeTransformFrame ? (
                <g>
                  <rect
                    x={activeTransformFrame.minX}
                    y={activeTransformFrame.minY}
                    width={activeTransformFrame.width}
                    height={activeTransformFrame.height}
                    rx={8}
                    fill="none"
                    stroke="#22d3ee"
                    strokeDasharray="8 6"
                    strokeWidth={2}
                    opacity={0.86}
                    pointerEvents="none"
                  />
                  <line
                    x1={activeTransformFrame.center.x}
                    y1={activeTransformFrame.minY}
                    x2={activeTransformFrame.rotate.x}
                    y2={activeTransformFrame.rotate.y}
                    stroke="#22d3ee"
                    strokeWidth={2}
                    strokeDasharray="5 5"
                    opacity={0.8}
                    pointerEvents="none"
                  />
                  <circle
                    className="cursor-grab active:cursor-grabbing"
                    cx={activeTransformFrame.rotate.x}
                    cy={activeTransformFrame.rotate.y}
                    r={14}
                    fill="#111827"
                    stroke="#22d3ee"
                    strokeWidth={2}
                    onPointerDown={(event) => handleTransformPointerDown(event, 'rotate')}
                  />
                  <text
                    x={activeTransformFrame.rotate.x}
                    y={activeTransformFrame.rotate.y + 4}
                    textAnchor="middle"
                    fontSize="12"
                    fontWeight="700"
                    fill="#fff"
                    pointerEvents="none"
                  >
                    R
                  </text>
                  <circle
                    className="cursor-nwse-resize"
                    cx={activeTransformFrame.scale.x}
                    cy={activeTransformFrame.scale.y}
                    r={14}
                    fill="#111827"
                    stroke="#22d3ee"
                    strokeWidth={2}
                    onPointerDown={(event) => handleTransformPointerDown(event, 'scale')}
                  />
                  <text
                    x={activeTransformFrame.scale.x}
                    y={activeTransformFrame.scale.y + 4}
                    textAnchor="middle"
                    fontSize="12"
                    fontWeight="700"
                    fill="#fff"
                    pointerEvents="none"
                  >
                    S
                  </text>
                </g>
              ) : null}
            </svg>
          </div>
          <div className="mt-2 rounded-[var(--t8-radius)] border border-dashed border-[var(--t8-border)] px-3 py-2 text-xs text-[var(--t8-text-muted)]">
            联动素材：文本 {upstreamTexts.length} · 参考图 {upstream.images.length}
            {referenceImage
              ? '（可作为淡底参考；左侧 image 可点识别上游）'
              : incomingReferenceImage
                ? '（当前参考背景已清空；点识别上游可重新显示）'
                : ''}
          </div>
          <div className="mt-3 grid grid-cols-3 gap-2">
            {POSE_RENDER_MODES.map((mode) => (
              <button
                key={mode.id}
                type="button"
                className={`t8-btn nodrag nopan ${renderMode === mode.id ? 't8-btn-primary' : ''}`}
                onClick={() => setRenderMode(mode.id)}
                title={`${mode.zh}预览；运行时也会输出这个模式的图片`}
              >
                {mode.zh}
              </button>
            ))}
          </div>
          <div className="mt-2 grid grid-cols-4 gap-2">
            <button
              type="button"
              className="t8-btn nodrag nopan"
              onClick={() => setActivePosePoints((prev) => mirrorPoints(prev, poseCanvas))}
              disabled={posePeople.length === 0}
            >
              镜像
            </button>
            <button
              type="button"
              className={`t8-btn nodrag nopan ${dragMode === 'body' ? 't8-btn-primary' : ''}`}
              onClick={() => setDragMode((prev) => (prev === 'body' ? 'joint' : 'body'))}
              disabled={posePeople.length === 0}
              title="抓取模式会拖动整个人物主体，适合多人构图时移动位置"
            >
              <Move size={14} /> 抓取
            </button>
            <button
              type="button"
              className="t8-btn nodrag nopan"
              onClick={() => void recognizePoseFromImageUrl(upstreamImageUrl, '上游图')}
              disabled={!upstreamImageUrl || recognitionBusy}
              title="使用左侧 image 输入的第一张图片识别姿态，识别后可切换线稿 / OpenPose / COCO 预览并运行输出"
            >
              <ImagePlus size={14} /> {recognitionBusy ? '识别中' : '识别上游'}
            </button>
            <button
              type="button"
              className="t8-btn nodrag nopan"
              onClick={() => imageInputRef.current?.click()}
              title="导入人物图并用 MediaPipe Pose 识别姿态"
            >
              <ImagePlus size={14} /> 本地识别
            </button>
            <button
              type="button"
              className="t8-btn nodrag nopan"
              onClick={clearPeople}
              disabled={!hasClearableContent}
              title="清空姿态画布上的人物和当前参考背景"
            >
              <Trash2 size={14} /> 清空
            </button>
            <button
              type="button"
              className="t8-btn nodrag nopan"
              onClick={() => exportKeypoints('openpose')}
              title="导出 OpenPose keypoints JSON"
              disabled={posePeople.length === 0}
            >
              <FileJson size={14} /> OP JSON
            </button>
            <button
              type="button"
              className="t8-btn nodrag nopan"
              onClick={() => exportKeypoints('coco')}
              title="导出 COCO keypoints JSON"
              disabled={posePeople.length === 0}
            >
              <FileJson size={14} /> COCO JSON
            </button>
            <button
              type="button"
              className="t8-btn nodrag nopan"
              onClick={() => downloadJson(`t8-pose-master-${Date.now()}.json`, currentBackup('当前姿势'))}
              title="只导出当前姿势 JSON"
            >
              <Download size={14} /> 导出
            </button>
            <button
              type="button"
              className="t8-btn nodrag nopan"
              onClick={() => fileInputRef.current?.click()}
            >
              <Upload size={14} /> 导入
            </button>
            <button
              type="button"
              className="t8-btn nodrag nopan"
              onClick={exportPoseLibrary}
              title="导出当前姿势 + 姿势收藏库 JSON"
            >
              <Layers size={14} /> 导出库
            </button>
            <button
              type="button"
              className="t8-btn nodrag nopan"
              onClick={() => void handleSaveToResourceLibrary()}
              title="把当前姿势大师配置保存到资源库的姿势分类"
            >
              <PackagePlus size={14} /> 存资源库
            </button>
          </div>
          {status ? (
            <div className="mt-2 rounded-[var(--t8-radius)] border border-[var(--t8-border)] bg-[var(--t8-input-bg)] px-3 py-2 text-xs text-[var(--t8-text)]" role="status">
              {status}
            </div>
          ) : null}
          <div className="mt-2 text-[11px] leading-relaxed text-[var(--t8-text-muted)]">
            线稿 / OpenPose / COCO 会直接切换上方预览，运行输出图也跟随当前模式；JSON 按钮只导出 keypoints 数据。
          </div>
          <input ref={fileInputRef} type="file" accept="application/json,.json" className="hidden" onChange={handleImportJson} />
          <input ref={imageInputRef} type="file" accept="image/*" className="hidden" onChange={handleImportPoseImage} />
        </section>

        <section className="flex min-w-0 flex-col gap-3">
          <div className="t8-card grid grid-cols-[1fr_auto] gap-3 p-3">
            <label className="text-xs font-semibold text-[var(--t8-text-muted)]">
              人物
              <select
                className="t8-input nodrag nopan mt-1 w-full"
                value={safeActivePersonIndex}
                disabled={posePeople.length === 0}
                onChange={(event) => setActivePersonIndex(clamp(Number(event.target.value) || 0, 0, posePeople.length - 1))}
              >
                {posePeople.length === 0 ? (
                  <option value={0}>暂无人物，可点新增人物</option>
                ) : posePeople.map((_, index) => (
                  <option key={index} value={index}>
                    人物 {index + 1}{index === 0 ? ' / 主体' : ''}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex items-end gap-2">
              <button type="button" className="t8-mini-icon-button nodrag nopan" title="新增人物" onClick={addPerson}>
                <UserPlus size={15} />
              </button>
              <button type="button" className="t8-mini-icon-button nodrag nopan" title="复制当前人物" onClick={duplicatePerson}>
                <Copy size={15} />
              </button>
              <button type="button" className="t8-mini-icon-button nodrag nopan" title="删除当前人物" onClick={removePerson}>
                <UserMinus size={15} />
              </button>
              <button type="button" className="t8-mini-icon-button nodrag nopan" title="清空人物和当前参考背景" onClick={clearPeople} disabled={!hasClearableContent}>
                <Trash2 size={15} />
              </button>
            </div>
          </div>

          <div className="t8-card grid grid-cols-2 gap-3 p-3">
            <label className="text-xs font-semibold text-[var(--t8-text-muted)]">
              姿态预设（{POSE_PRESETS.length}）
              <select
                className="t8-input nodrag nopan mt-1 w-full"
                value={presetId}
                onChange={(event) => applyPreset(event.target.value)}
              >
                {POSE_PRESETS.map((preset) => (
                  <option key={preset.id} value={preset.id}>
                    {preset.label} / {preset.labelEn}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs font-semibold text-[var(--t8-text-muted)]">
              语言
              <select
                className="t8-input nodrag nopan mt-1 w-full"
                value={language}
                onChange={(event) => setLanguage(event.target.value === 'zh' ? 'zh' : 'en')}
              >
                <option value="en">English prompt</option>
                <option value="zh">中文 prompt</option>
              </select>
            </label>
            <label className="text-xs font-semibold text-[var(--t8-text-muted)]">
              视角
              <select
                className="t8-input nodrag nopan mt-1 w-full"
                value={viewId}
                onChange={(event) => setViewId(event.target.value)}
              >
                {VIEW_OPTIONS.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.zh} / {item.en}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs font-semibold text-[var(--t8-text-muted)]">
              景别
              <select
                className="t8-input nodrag nopan mt-1 w-full"
                value={shotId}
                onChange={(event) => setShotId(event.target.value)}
              >
                {SHOT_OPTIONS.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.zh} / {item.en}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs font-semibold text-[var(--t8-text-muted)]">
              姿势强度
              <select
                className="t8-input nodrag nopan mt-1 w-full"
                value={intensityId}
                onChange={(event) => setIntensityId(safeIntensityId(event.target.value))}
              >
                {POSE_INTENSITY_OPTIONS.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.zh} / {item.en}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="t8-card grid grid-cols-2 gap-3 p-3">
            <div className="col-span-2 flex items-center gap-2 text-sm font-semibold">
              <Hand size={15} /> 手部简化控制
            </div>
            {(['left', 'right'] as const).map((side) => (
              <div key={side} className="rounded-[var(--t8-radius)] border border-[var(--t8-border)] bg-[var(--t8-input-bg)] p-2">
                <div className="mb-2 text-xs font-semibold text-[var(--t8-text-muted)]">
                  {side === 'left' ? '左手' : '右手'}
                </div>
                <select
                  className="t8-input nodrag nopan mb-2 w-full text-xs"
                  value={handControls[side].shape}
                  onChange={(event) =>
                    setHandControls((prev) => ({
                      ...prev,
                      [side]: { ...prev[side], shape: safeHandShape(event.target.value) },
                    }))
                  }
                >
                  {HAND_SHAPE_OPTIONS.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.zh} / {item.en}
                    </option>
                  ))}
                </select>
                <select
                  className="t8-input nodrag nopan w-full text-xs"
                  value={handControls[side].direction}
                  onChange={(event) =>
                    setHandControls((prev) => ({
                      ...prev,
                      [side]: { ...prev[side], direction: safeHandDirection(event.target.value) },
                    }))
                  }
                >
                  {HAND_DIRECTION_OPTIONS.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.zh} / {item.en}
                    </option>
                  ))}
                </select>
              </div>
            ))}
          </div>

          <label className="t8-card block p-3 text-xs font-semibold text-[var(--t8-text-muted)]">
            自定义补充
            <textarea
              className="t8-input nodrag nopan mt-2 h-20 w-full resize-none"
              value={custom}
              onChange={(event) => setCustom(event.target.value)}
              placeholder={language === 'en' ? 'extra action, emotion, camera notes...' : '补充动作、情绪、镜头说明...'}
            />
          </label>

          <div className="t8-card p-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <div>
                <div className="text-sm font-semibold">姿势收藏</div>
                <div className="text-xs text-[var(--t8-text-muted)]">保存常用动作，JSON 可整体导入/导出复用</div>
              </div>
              <div className="flex shrink-0 gap-2">
                <button type="button" className="t8-mini-icon-button nodrag nopan" title="收藏当前姿势" onClick={saveFavorite}>
                  <Star size={15} />
                </button>
                <button type="button" className="t8-mini-icon-button nodrag nopan" title="导出姿势库" onClick={exportPoseLibrary}>
                  <Download size={15} />
                </button>
                <button type="button" className="t8-mini-icon-button nodrag nopan" title="导入姿势 JSON / 姿势库" onClick={() => fileInputRef.current?.click()}>
                  <Upload size={15} />
                </button>
              </div>
            </div>
            <div className="max-h-24 space-y-2 overflow-y-auto pr-1">
              {favorites.length === 0 ? (
                <div className="rounded-[var(--t8-radius)] border border-dashed border-[var(--t8-border)] px-3 py-2 text-xs text-[var(--t8-text-muted)]">
                  暂无收藏。调好姿势后点星标即可保存。
                </div>
              ) : (
                favorites.map((fav) => (
                  <div key={fav.id} className="flex items-center gap-2 rounded-[var(--t8-radius)] border border-[var(--t8-border)] bg-[var(--t8-input-bg)] px-2 py-1">
                    <button
                      type="button"
                      className="nodrag nopan min-w-0 flex-1 truncate text-left text-xs font-semibold text-[var(--t8-text)]"
                      title={fav.name}
                      onClick={() => applyBackup(fav)}
                    >
                      {fav.name}
                    </button>
                    <button
                      type="button"
                      className="t8-mini-icon-button nodrag nopan"
                      title="删除收藏"
                      onClick={() => removeFavorite(fav.id)}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="t8-card grid grid-cols-[1fr_92px] gap-3 p-3">
            <label className="text-xs font-semibold text-[var(--t8-text-muted)]">
              批量模式
              <select
                className="t8-input nodrag nopan mt-1 w-full"
                value={batchMode}
                onChange={(event) => setBatchMode(safeBatchMode(event.target.value))}
              >
                {POSE_BATCH_MODES.map((mode) => (
                  <option key={mode.id} value={mode.id}>
                    {mode.zh} / {mode.en}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs font-semibold text-[var(--t8-text-muted)]">
              数量
              <input
                className="t8-input nodrag nopan mt-1 w-full text-center tabular-nums"
                type="number"
                min={1}
                max={8}
                value={batchCount}
                onChange={(event) => setBatchCount(safeBatchCount(event.target.value))}
              />
            </label>
            <button
              type="button"
              className="t8-btn nodrag nopan col-span-2"
              onClick={() => requestPoseMasterRun('batch')}
            >
              <Shuffle size={15} /> 批量输出分镜姿势
            </button>
          </div>

          <div className="t8-card grid grid-cols-[1fr_1fr_92px] gap-3 p-3">
            <button type="button" className="t8-btn nodrag nopan" onClick={() => saveKeyframe('A')}>
              设为 A 帧
            </button>
            <button type="button" className="t8-btn nodrag nopan" onClick={() => saveKeyframe('B')}>
              设为 B 帧
            </button>
            <label className="text-xs font-semibold text-[var(--t8-text-muted)]">
              帧数
              <input
                className="t8-input nodrag nopan mt-1 w-full text-center tabular-nums"
                type="number"
                min={2}
                max={24}
                value={keyframeCount}
                onChange={(event) => setKeyframeCount(clamp(Math.round(Number(event.target.value)) || 6, 2, 24))}
              />
            </label>
            <div className="col-span-3 grid grid-cols-2 gap-2 text-[11px] text-[var(--t8-text-muted)]">
              <div>A：{keyframeA ? keyframeA.name || '已保存' : '未设置'}</div>
              <div>B：{keyframeB ? keyframeB.name || '已保存' : '未设置'}</div>
            </div>
            <button type="button" className="t8-btn nodrag nopan col-span-3" onClick={() => requestPoseMasterRun('keyframes')}>
              <Play size={15} /> 输出 A→B 关键帧序列
            </button>
          </div>

          <div className="t8-card p-3">
            <div className="mb-2 flex items-center justify-between">
              <div className="text-sm font-semibold">输出到下游 prompt</div>
              <button
                type="button"
                className="t8-mini-icon-button nodrag nopan"
                title="复制 prompt"
                onClick={() => navigator.clipboard?.writeText(prompt)}
              >
                <Copy size={15} />
              </button>
            </div>
            <pre className="max-h-32 whitespace-pre-wrap break-words rounded-[var(--t8-radius)] border border-[var(--t8-border)] bg-[var(--t8-input-bg)] p-3 text-xs leading-relaxed text-[var(--t8-text)]">
              {prompt}
            </pre>
          </div>

          <button
            type="button"
            className="t8-btn t8-btn-primary nodrag nopan h-12 w-full text-base font-bold"
            onClick={() => requestPoseMasterRun('single')}
          >
            <Play size={16} /> 运行输出{renderModeLabel}
          </button>
          <div className="min-h-5 text-xs text-[var(--t8-text-muted)]">{status}</div>
        </section>
      </div>
    </div>
  );
};

export default memo(PoseMasterNode);
