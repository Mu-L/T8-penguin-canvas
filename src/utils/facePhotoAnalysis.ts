import type { FaceChannel, FacePhotoCalibration } from './faceExpression3D';
import { FACE_CHANNELS, clampFaceValue } from './faceExpression3D';

const MEDIAPIPE_WASM_BASE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm';
const MEDIAPIPE_FACE_MODEL =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task';

export interface FacePhotoAnalysisResult {
  calibration: FacePhotoCalibration;
  blendshapes: Partial<Record<FaceChannel, number>>;
  landmarkCount: number;
  faceCount: number;
  warnings: string[];
}
type Point = { x: number; y: number; z?: number };

let faceLandmarkerPromise: Promise<any> | null = null;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function midpoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function ratioScale(value: number, baseline: number, min = 0.72, max = 1.35): number {
  if (!Number.isFinite(value) || value <= 0 || baseline <= 0) return 1;
  return Number(clamp(value / baseline, min, max).toFixed(3));
}

function point(landmarks: Point[], index: number): Point {
  const value = landmarks[index];
  if (!value || !Number.isFinite(value.x) || !Number.isFinite(value.y)) {
    throw new Error(`人脸关键点缺失: ${index}`);
  }
  return value;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    let retried = false;
    const start = (anonymous: boolean) => {
      const image = new Image();
      if (anonymous) image.crossOrigin = 'anonymous';
      image.onload = () => resolve(image);
      image.onerror = () => {
        if (anonymous && !retried) {
          retried = true;
          start(false);
          return;
        }
        reject(new Error('人物脸部图片加载失败'));
      };
      image.src = src;
    };
    start(true);
  });
}

async function getFaceLandmarker() {
  if (!faceLandmarkerPromise) {
    faceLandmarkerPromise = (async () => {
      const { FaceLandmarker, FilesetResolver } = await import('@mediapipe/tasks-vision');
      const vision = await FilesetResolver.forVisionTasks(MEDIAPIPE_WASM_BASE);
      const create = async (delegate: 'GPU' | 'CPU') => FaceLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: MEDIAPIPE_FACE_MODEL, delegate },
        runningMode: 'IMAGE',
        numFaces: 1,
        minFaceDetectionConfidence: 0.55,
        minFacePresenceConfidence: 0.55,
        outputFaceBlendshapes: true,
        outputFacialTransformationMatrixes: true,
      });
      try {
        return await create('GPU');
      } catch {
        return create('CPU');
      }
    })().catch((error) => {
      faceLandmarkerPromise = null;
      throw error;
    });
  }
  return faceLandmarkerPromise;
}

function rgbToHex(rgb: [number, number, number], fallback: string): string {
  if (!rgb.every(Number.isFinite)) return fallback;
  return `#${rgb.map((value) => clamp(Math.round(value), 0, 255).toString(16).padStart(2, '0')).join('')}`.toUpperCase();
}

function averagePatch(
  ctx: CanvasRenderingContext2D,
  image: HTMLImageElement,
  normalized: Point,
  radius = 5,
): [number, number, number] | null {
  const x = clamp(Math.round(normalized.x * image.naturalWidth), 0, image.naturalWidth - 1);
  const y = clamp(Math.round(normalized.y * image.naturalHeight), 0, image.naturalHeight - 1);
  const left = clamp(x - radius, 0, image.naturalWidth - 1);
  const top = clamp(y - radius, 0, image.naturalHeight - 1);
  const width = Math.max(1, Math.min(radius * 2 + 1, image.naturalWidth - left));
  const height = Math.max(1, Math.min(radius * 2 + 1, image.naturalHeight - top));
  const pixels = ctx.getImageData(left, top, width, height).data;
  let r = 0;
  let g = 0;
  let b = 0;
  let weight = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    const alpha = pixels[i + 3] / 255;
    if (alpha < 0.4) continue;
    const max = Math.max(pixels[i], pixels[i + 1], pixels[i + 2]);
    const min = Math.min(pixels[i], pixels[i + 1], pixels[i + 2]);
    if (max > 248 || min < 8) continue;
    r += pixels[i] * alpha;
    g += pixels[i + 1] * alpha;
    b += pixels[i + 2] * alpha;
    weight += alpha;
  }
  return weight > 0 ? [r / weight, g / weight, b / weight] : null;
}

function mixColors(colors: Array<[number, number, number] | null>, fallback: string): string {
  const valid = colors.filter((value): value is [number, number, number] => !!value);
  if (!valid.length) return fallback;
  return rgbToHex([
    valid.reduce((sum, value) => sum + value[0], 0) / valid.length,
    valid.reduce((sum, value) => sum + value[1], 0) / valid.length,
    valid.reduce((sum, value) => sum + value[2], 0) / valid.length,
  ], fallback);
}

function sampledColors(image: HTMLImageElement, landmarks: Point[]) {
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return { skinColor: '#D8A17E', hairColor: '#2B211D', irisColor: '#4B6B78', warning: '浏览器无法读取图片颜色' };
  try {
    ctx.drawImage(image, 0, 0);
    const skinColor = mixColors([
      averagePatch(ctx, image, point(landmarks, 50), 7),
      averagePatch(ctx, image, point(landmarks, 280), 7),
      averagePatch(ctx, image, point(landmarks, 6), 6),
    ], '#D8A17E');
    const forehead = point(landmarks, 10);
    const hairPoint = { x: forehead.x, y: clamp(forehead.y - 0.045, 0, 1) };
    const hairColor = mixColors([averagePatch(ctx, image, hairPoint, 9)], '#2B211D');
    const leftIris = landmarks[468] || midpoint(point(landmarks, 33), point(landmarks, 133));
    const rightIris = landmarks[473] || midpoint(point(landmarks, 362), point(landmarks, 263));
    const irisColor = mixColors([
      averagePatch(ctx, image, leftIris, 2),
      averagePatch(ctx, image, rightIris, 2),
    ], '#4B6B78');
    return { skinColor, hairColor, irisColor, warning: '' };
  } catch {
    return { skinColor: '#D8A17E', hairColor: '#2B211D', irisColor: '#4B6B78', warning: '图片跨域限制，已保留默认颜色' };
  }
}

function blendshapeRecord(result: any): Partial<Record<FaceChannel, number>> {
  const categories = result?.faceBlendshapes?.[0]?.categories;
  if (!Array.isArray(categories)) return {};
  const channelSet = new Set<string>(FACE_CHANNELS);
  const out: Partial<Record<FaceChannel, number>> = {};
  for (const category of categories) {
    const name = String(category?.categoryName || category?.displayName || '');
    if (!channelSet.has(name)) continue;
    out[name as FaceChannel] = clampFaceValue(category?.score);
  }
  return out;
}

function calibrationFromLandmarks(
  sourceUrl: string,
  landmarks: Point[],
  colors: { skinColor: string; hairColor: string; irisColor: string },
  confidence: number,
): FacePhotoCalibration {
  const faceWidth = distance(point(landmarks, 234), point(landmarks, 454));
  const faceHeight = distance(point(landmarks, 10), point(landmarks, 152));
  const leftEyeOuter = point(landmarks, 33);
  const leftEyeInner = point(landmarks, 133);
  const rightEyeInner = point(landmarks, 362);
  const rightEyeOuter = point(landmarks, 263);
  const leftEyeCenter = midpoint(leftEyeOuter, leftEyeInner);
  const rightEyeCenter = midpoint(rightEyeInner, rightEyeOuter);
  const eyeSpacing = distance(leftEyeCenter, rightEyeCenter) / Math.max(faceWidth, 0.0001);
  const eyeSize = ((distance(leftEyeOuter, leftEyeInner) + distance(rightEyeInner, rightEyeOuter)) / 2) / Math.max(faceWidth, 0.0001);
  const browCenter = midpoint(point(landmarks, 105), point(landmarks, 334));
  const eyeCenter = midpoint(leftEyeCenter, rightEyeCenter);
  const jawWidth = distance(point(landmarks, 172), point(landmarks, 397)) / Math.max(faceWidth, 0.0001);
  const noseLength = distance(point(landmarks, 168), point(landmarks, 1)) / Math.max(faceHeight, 0.0001);
  const noseWidth = distance(point(landmarks, 98), point(landmarks, 327)) / Math.max(faceWidth, 0.0001);
  const mouthWidth = distance(point(landmarks, 61), point(landmarks, 291)) / Math.max(faceWidth, 0.0001);
  const lipThickness = distance(point(landmarks, 13), point(landmarks, 14)) / Math.max(faceHeight, 0.0001);
  return {
    sourceUrl,
    analyzedAt: new Date().toISOString(),
    confidence: Number(clamp(confidence, 0, 1).toFixed(3)),
    faceWidth: ratioScale(faceWidth / Math.max(faceHeight, 0.0001), 0.78, 0.78, 1.25),
    faceHeight: ratioScale(faceHeight / Math.max(faceWidth, 0.0001), 1.28, 0.82, 1.22),
    jawWidth: ratioScale(jawWidth, 0.72, 0.76, 1.24),
    eyeSpacing: ratioScale(eyeSpacing, 0.42, 0.78, 1.23),
    eyeSize: ratioScale(eyeSize, 0.19, 0.78, 1.28),
    browHeight: ratioScale(distance(browCenter, eyeCenter) / Math.max(faceHeight, 0.0001), 0.14, 0.78, 1.3),
    noseLength: ratioScale(noseLength, 0.29, 0.78, 1.28),
    noseWidth: ratioScale(noseWidth, 0.25, 0.76, 1.28),
    mouthWidth: ratioScale(mouthWidth, 0.42, 0.76, 1.3),
    lipThickness: ratioScale(lipThickness, 0.038, 0.72, 1.38),
    skinColor: colors.skinColor,
    hairColor: colors.hairColor,
    irisColor: colors.irisColor,
  };
}

export async function analyzeFacePhoto(sourceUrl: string): Promise<FacePhotoAnalysisResult> {
  if (!sourceUrl || typeof sourceUrl !== 'string') throw new Error('请选择人物脸部图片');
  const [landmarker, image] = await Promise.all([getFaceLandmarker(), loadImage(sourceUrl)]);
  const result = landmarker.detect(image);
  const faces = Array.isArray(result?.faceLandmarks) ? result.faceLandmarks : [];
  if (!faces.length) throw new Error('没有检测到清晰的正面人脸，请换一张单人、无遮挡、光线均匀的图片');
  const landmarks = faces[0] as Point[];
  if (landmarks.length < 468) throw new Error(`人脸关键点不完整，仅检测到 ${landmarks.length} 点`);
  const colors = sampledColors(image, landmarks);
  const blendshapes = blendshapeRecord(result);
  const confidence = Number(result?.faceBlendshapes?.[0]?.categories?.find((item: any) => item?.categoryName === '_neutral')?.score ?? 0.8);
  const warnings = [colors.warning].filter(Boolean);
  return {
    calibration: calibrationFromLandmarks(sourceUrl, landmarks, colors, confidence),
    blendshapes,
    landmarkCount: landmarks.length,
    faceCount: faces.length,
    warnings,
  };
}
