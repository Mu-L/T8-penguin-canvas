const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const MAX_JSON_DEPTH = 24;
const MAX_JSON_KEYS = 12_000;
const MAX_JSON_ASSET_BYTES = 8 * 1024 * 1024;
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
  let entries;
  if (typeof value === 'string') entries = value.split(',');
  else if (value && typeof value[Symbol.iterator] === 'function') entries = Array.from(value);
  else entries = value == null ? [] : [value];
  const origins = new Set();
  for (const entry of entries) {
    try {
      const parsed = new URL(String(entry || '').trim());
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.origin === 'null') continue;
      origins.add(parsed.origin);
    } catch (_) {
      // Invalid configured origins fail closed instead of becoming string matches.
    }
  }
  return origins;
}

function buildCollaborationAllowedOrigins(options = {}) {
  const result = new Set();
  for (const source of [options.shareUrls, options.configuredOrigins, options.publicBaseUrl]) {
    for (const origin of normalizeAllowedOrigins(source)) result.add(origin);
  }
  return result;
}

function normalizeRequestOrigin(origin) {
  const raw = String(origin || '').trim();
  if (!raw || raw === 'null') return null;
  try {
    const parsed = new URL(raw);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.origin === 'null') return null;
    if ((parsed.pathname && parsed.pathname !== '/') || parsed.search || parsed.hash) return null;
    return parsed.origin;
  } catch (_) {
    return null;
  }
}

function originAllowed(origin, allowedOrigins) {
  // CLI/native clients do not send Origin. They still cross the normal session,
  // capability and SameSite/CSRF boundaries; browser-supplied Origin is exact-match.
  if (!origin) return true;
  const normalized = normalizeRequestOrigin(origin);
  return Boolean(normalized && normalizeAllowedOrigins(allowedOrigins).has(normalized));
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
  if (startsWith(buffer, [0x50, 0x4b, 0x03, 0x04])
    || startsWith(buffer, [0x50, 0x4b, 0x05, 0x06])
    || startsWith(buffer, [0x50, 0x4b, 0x07, 0x08])) return 'archive';
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
  if (extension === 'zip' || detected === 'archive') {
    throw new Error('协作上传不接受 ZIP/归档容器；请先解压并上传明确的素材文件');
  }
  if (expectedKind === 'text') {
    if (extension === 'json') {
      const size = Number(fs.statSync(filename).size || 0);
      if (size > MAX_JSON_ASSET_BYTES) {
        throw new Error('JSON 素材超过 8 MiB 安全上限');
      }
    }
    if (!looksLikeText(buffer)) throw new Error('文件内容不是有效文本');
    if (extension === 'json') {
      const parsed = JSON.parse(fs.readFileSync(filename, 'utf8'));
      inspectJsonComplexity(parsed);
    }
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
  MAX_JSON_ASSET_BYTES,
  MAX_JSON_DEPTH,
  MAX_JSON_KEYS,
  detectBinaryKind,
  buildCollaborationAllowedOrigins,
  inspectJsonComplexity,
  normalizeAllowedOrigins,
  normalizeRequestOrigin,
  originAllowed,
  validateUploadedAsset,
};
