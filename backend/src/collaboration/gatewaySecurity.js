const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const MAX_JSON_DEPTH = 24;
const MAX_JSON_KEYS = 12_000;
const MAX_IMAGE_PIXELS = 100_000_000;

function inspectJsonComplexity(value, limits = {}) {
  const maxDepth = Math.max(1, Number(limits.maxDepth) || MAX_JSON_DEPTH);
  const maxKeys = Math.max(1, Number(limits.maxKeys) || MAX_JSON_KEYS);
  let keys = 0;
  const stack = [{ value, depth: 0 }];
  while (stack.length) {
    const current = stack.pop();
    if (current.depth > maxDepth) throw new Error('JSON 嵌套层级过深');
    if (!current.value || typeof current.value !== 'object') continue;
    const entries = Array.isArray(current.value) ? current.value.map((item, index) => [index, item]) : Object.entries(current.value);
    keys += entries.length;
    if (keys > maxKeys) throw new Error('JSON 字段数量过多');
    for (const [, child] of entries) stack.push({ value: child, depth: current.depth + 1 });
  }
  return { depthLimit: maxDepth, keys };
}

function normalizeAllowedOrigins(value) {
  const entries = Array.isArray(value) ? value : String(value || '').split(',');
  return new Set(entries.map((entry) => String(entry).trim().replace(/\/$/, '')).filter(Boolean));
}

function originAllowed(origin, host, configuredOrigins) {
  if (!origin) return true;
  try {
    const parsed = new URL(String(origin));
    if (parsed.host === String(host || '')) return true;
    return normalizeAllowedOrigins(configuredOrigins).has(parsed.origin);
  } catch (_) {
    return false;
  }
}

function startsWith(buffer, bytes, offset = 0) {
  return bytes.every((byte, index) => buffer[offset + index] === byte);
}

function ascii(buffer, start, length) {
  return buffer.subarray(start, start + length).toString('ascii');
}

function detectBinaryKind(buffer) {
  if (startsWith(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image';
  if (startsWith(buffer, [0xff, 0xd8, 0xff]) || ascii(buffer, 0, 6) === 'GIF87a' || ascii(buffer, 0, 6) === 'GIF89a') return 'image';
  if (ascii(buffer, 0, 4) === 'RIFF' && ascii(buffer, 8, 4) === 'WEBP') return 'image';
  if (ascii(buffer, 4, 4) === 'ftyp') return 'video-audio';
  if (startsWith(buffer, [0x1a, 0x45, 0xdf, 0xa3])) return 'video';
  if (ascii(buffer, 0, 4) === 'RIFF' && ['WAVE', 'AVI '].includes(ascii(buffer, 8, 4))) return ascii(buffer, 8, 4) === 'WAVE' ? 'audio' : 'video';
  if (ascii(buffer, 0, 3) === 'ID3' || (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0)) return 'audio';
  if (ascii(buffer, 0, 4) === 'OggS' || ascii(buffer, 0, 4) === 'fLaC') return 'audio';
  if (ascii(buffer, 0, 4) === 'glTF') return 'model3d';
  if (ascii(buffer, 0, 18) === 'Kaydara FBX Binary') return 'model3d';
  if (startsWith(buffer, [0x50, 0x4b, 0x03, 0x04])) return 'archive';
  return null;
}

function looksLikeText(buffer) {
  if (!buffer.length || buffer.includes(0)) return false;
  const sample = buffer.toString('utf8');
  const replacements = (sample.match(/\uFFFD/g) || []).length;
  return replacements <= Math.max(1, Math.floor(sample.length * 0.01));
}

async function validateUploadedAsset(filename, info) {
  const handle = fs.openSync(filename, 'r');
  const sample = Buffer.alloc(512);
  let bytesRead = 0;
  try { bytesRead = fs.readSync(handle, sample, 0, sample.length, 0); } finally { fs.closeSync(handle); }
  const buffer = sample.subarray(0, bytesRead);
  const detected = detectBinaryKind(buffer);
  const extension = String(info?.extension || path.extname(filename).slice(1)).toLowerCase();
  const expectedKind = String(info?.kind || 'other');
  if (expectedKind === 'text') {
    if (!looksLikeText(buffer)) throw new Error('文件内容不是有效文本');
    if (extension === 'json') JSON.parse(fs.readFileSync(filename, 'utf8'));
    return { detectedKind: 'text' };
  }
  if (expectedKind === 'image') {
    if (detected !== 'image' && !['bmp', 'avif'].includes(extension)) throw new Error('文件内容与图片扩展名不一致');
    const metadata = await sharp(filename, { failOn: 'error', limitInputPixels: MAX_IMAGE_PIXELS }).metadata();
    if (!metadata.width || !metadata.height || metadata.width * metadata.height > MAX_IMAGE_PIXELS) throw new Error('图片像素尺寸超过协作上传上限');
    if ((metadata.pages || 1) > 500) throw new Error('多帧图片页数超过协作上传上限');
    return { detectedKind: 'image', width: metadata.width, height: metadata.height, pages: metadata.pages || 1 };
  }
  if (expectedKind === 'model3d') {
    if (!['model3d', 'archive'].includes(detected) && !looksLikeText(buffer)) throw new Error('文件内容与 3D 扩展名不一致');
    return { detectedKind: 'model3d' };
  }
  if (expectedKind === 'video' && !['video', 'video-audio'].includes(detected)) throw new Error('文件内容与视频扩展名不一致');
  if (expectedKind === 'audio' && !['audio', 'video-audio'].includes(detected)) throw new Error('文件内容与音频扩展名不一致');
  return { detectedKind: expectedKind };
}

module.exports = {
  MAX_IMAGE_PIXELS,
  MAX_JSON_DEPTH,
  MAX_JSON_KEYS,
  detectBinaryKind,
  inspectJsonComplexity,
  normalizeAllowedOrigins,
  originAllowed,
  validateUploadedAsset,
};
