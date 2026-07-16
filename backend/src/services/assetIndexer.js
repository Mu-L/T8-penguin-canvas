const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { StringDecoder } = require('string_decoder');
const sharp = require('sharp');
const { resolveBundledFfmpeg, resolveBundledFfprobe } = require('../providers/llmMedia');

const MAX_IMAGE_INPUT_PIXELS = 100_000_000;
const PHASH_DCT64_ALGORITHM = 'phash-dct64-v1';
const DEFAULT_ASSET_PREVIEW_PIPELINE_VERSION = 'asset-preview-v2-phash';
const PHASH_SAMPLE_SIZE = 32;
const PHASH_LOW_FREQUENCY_SIZE = 8;
const PHASH_DCT_COSINES = Object.freeze(Array.from(
  { length: PHASH_LOW_FREQUENCY_SIZE },
  (_, frequency) => Object.freeze(Array.from(
    { length: PHASH_SAMPLE_SIZE },
    (_, position) => Math.cos(((2 * position + 1) * frequency * Math.PI) / (2 * PHASH_SAMPLE_SIZE)),
  )),
));
const PHASH_DCT_SCALES = Object.freeze(Array.from(
  { length: PHASH_LOW_FREQUENCY_SIZE },
  (_, frequency) => frequency === 0 ? Math.sqrt(1 / PHASH_SAMPLE_SIZE) : Math.sqrt(2 / PHASH_SAMPLE_SIZE),
));
const MODEL_METADATA_LIMITS = Object.freeze({
  // Keep the source gate aligned with modelPreviewRenderer. Text/JSON parsing is
  // deliberately stricter because JavaScript strings and parsed objects can use
  // several times the on-disk byte count.
  maxSourceBytes: 128 * 1024 * 1024,
  maxJsonBytes: 16 * 1024 * 1024,
  maxMtlBytes: 8 * 1024 * 1024,
  maxMtlTotalBytes: 32 * 1024 * 1024,
  maxLineBytes: 1_000_000,
  maxLines: 2_000_000,
  maxVertices: 500_000,
  maxTriangles: 1_000_000,
  maxFaceVertices: 4096,
  maxReferences: 4096,
  maxMaterialLibraries: 64,
  maxReferenceBytes: 4096,
  maxGltfEntries: 500_000,
  maxGlbChunks: 128,
});

class AssetModelMetadataError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AssetModelMetadataError';
    this.code = code;
  }
}

function failModelMetadata(code, message) {
  throw new AssetModelMetadataError(code, message);
}

function normalizeModelMetadataLimits(overrides = {}) {
  const bounded = (name) => {
    const maximum = MODEL_METADATA_LIMITS[name];
    const requested = Math.trunc(Number(overrides?.[name]));
    return Number.isSafeInteger(requested) && requested > 0 ? Math.min(maximum, requested) : maximum;
  };
  const limits = Object.fromEntries(Object.keys(MODEL_METADATA_LIMITS).map((name) => [name, bounded(name)]));
  limits.maxJsonBytes = Math.min(limits.maxJsonBytes, limits.maxSourceBytes);
  limits.maxMtlBytes = Math.min(limits.maxMtlBytes, limits.maxSourceBytes);
  limits.maxMtlTotalBytes = Math.max(limits.maxMtlBytes, limits.maxMtlTotalBytes);
  return limits;
}

function statBoundedModelFile(filename, maximumBytes, label = '3D 模型') {
  let stat;
  try { stat = fs.statSync(path.resolve(filename)); } catch (_) { failModelMetadata('MODEL_SOURCE_UNREADABLE', `${label}不可读取`); }
  if (!stat.isFile()) failModelMetadata('MODEL_SOURCE_NOT_FILE', `${label}不是普通文件`);
  if (stat.size < 1) failModelMetadata('MODEL_SOURCE_EMPTY', `${label}为空`);
  if (stat.size > maximumBytes) failModelMetadata('MODEL_SOURCE_TOO_LARGE', `${label}超过 ${maximumBytes} bytes 安全上限`);
  return stat;
}

function readExactSync(fileDescriptor, length, position, label) {
  const output = Buffer.allocUnsafe(length);
  let offset = 0;
  while (offset < length) {
    const bytesRead = fs.readSync(fileDescriptor, output, offset, length - offset, position + offset);
    if (!bytesRead) failModelMetadata('INVALID_MODEL_METADATA', `${label}数据被截断`);
    offset += bytesRead;
  }
  return output;
}

function scanUtf8LinesSync(filename, options, visitor) {
  const limits = normalizeModelMetadataLimits(options?.limits);
  const maximumBytes = Math.min(limits.maxSourceBytes, Number(options?.maximumBytes) || limits.maxSourceBytes);
  const label = String(options?.label || '3D 模型');
  statBoundedModelFile(filename, maximumBytes, label);
  const descriptor = fs.openSync(path.resolve(filename), 'r');
  const decoder = new StringDecoder('utf8');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let pending = '';
  let lineNumber = 0;
  const emit = (line) => {
    lineNumber += 1;
    if (lineNumber > limits.maxLines) failModelMetadata('MODEL_METADATA_TOO_COMPLEX', `${label}行数超过 ${limits.maxLines}`);
    if (Buffer.byteLength(line, 'utf8') > limits.maxLineBytes) failModelMetadata('MODEL_METADATA_TOO_COMPLEX', `${label}第 ${lineNumber} 行过长`);
    visitor(line.replace(/\r$/, ''), lineNumber, limits);
  };
  try {
    while (true) {
      const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      const chunk = buffer.subarray(0, bytesRead);
      if (chunk.includes(0)) failModelMetadata('INVALID_MODEL_METADATA', `${label}包含无效二进制数据`);
      pending += decoder.write(chunk);
      let lineStart = 0;
      let newline;
      while ((newline = pending.indexOf('\n', lineStart)) !== -1) {
        emit(pending.slice(lineStart, newline));
        lineStart = newline + 1;
      }
      if (lineStart) pending = pending.slice(lineStart);
      if (Buffer.byteLength(pending, 'utf8') > limits.maxLineBytes) failModelMetadata('MODEL_METADATA_TOO_COMPLEX', `${label}行长度超过 ${limits.maxLineBytes}`);
    }
    pending += decoder.end();
    if (pending) emit(pending);
  } finally {
    fs.closeSync(descriptor);
  }
  return { lines: lineNumber, limits };
}

const EXTENSION_INFO = Object.freeze({
  png: ['image', 'image/png'], jpg: ['image', 'image/jpeg'], jpeg: ['image', 'image/jpeg'], webp: ['image', 'image/webp'], gif: ['image', 'image/gif'], bmp: ['image', 'image/bmp'], avif: ['image', 'image/avif'], tif: ['image', 'image/tiff'], tiff: ['image', 'image/tiff'],
  mp4: ['video', 'video/mp4'], webm: ['video', 'video/webm'], mov: ['video', 'video/quicktime'], m4v: ['video', 'video/x-m4v'], mkv: ['video', 'video/x-matroska'], avi: ['video', 'video/x-msvideo'],
  mp3: ['audio', 'audio/mpeg'], wav: ['audio', 'audio/wav'], ogg: ['audio', 'audio/ogg'], m4a: ['audio', 'audio/mp4'], flac: ['audio', 'audio/flac'], aac: ['audio', 'audio/aac'],
  glb: ['model3d', 'model/gltf-binary'], gltf: ['model3d', 'model/gltf+json'], obj: ['model3d', 'model/obj'], fbx: ['model3d', 'application/octet-stream'], stl: ['model3d', 'model/stl'], usdz: ['model3d', 'model/vnd.usdz+zip'],
  txt: ['text', 'text/plain'], md: ['text', 'text/markdown'], json: ['text', 'application/json'], csv: ['text', 'text/csv'], srt: ['text', 'application/x-subrip'], vtt: ['text', 'text/vtt'],
});

function extensionInfo(filePath) {
  const extension = path.extname(filePath).slice(1).toLowerCase();
  const [kind = 'other', mimeType = 'application/octet-stream'] = EXTENSION_INFO[extension] || [];
  return { extension, kind, mimeType };
}

function stableAssetId(rootName, relativePath) {
  const digest = crypto.createHash('sha256').update(`${rootName}:${relativePath.replace(/\\/g, '/').toLowerCase()}`).digest('hex');
  return `asset_${digest.slice(0, 32)}`;
}

function stableSourceLocator(projectId, rootName, relativePath) {
  const normalizedPath = String(relativePath || '').replace(/\\/g, '/').toLowerCase();
  const digest = crypto.createHash('sha256').update(JSON.stringify([
    String(projectId || 'project-local'),
    String(rootName || 'linked').toLowerCase(),
    normalizedPath,
  ])).digest('hex');
  return `asset_source_${digest}`;
}

function versionedAssetId(rootName, relativePath, contentHash) {
  const hash = String(contentHash || '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new TypeError('内容版本 assetId 需要完整 SHA-256');
  return stableAssetId(rootName, `${String(relativePath || '')}\0sha256:${hash}`);
}

function isLoopbackHostname(hostname) {
  const normalized = String(hostname || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  return normalized === '127.0.0.1' || normalized === 'localhost' || normalized === '::1';
}

function isPathInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function nearestExistingPath(filename) {
  let current = path.resolve(filename);
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return current;
}

/**
 * Resolve only URLs served by this application's controlled output root. The
 * realpath checks prevent an output symlink (or an existing symlink parent for
 * a not-yet-written file) from escaping OUTPUT_DIR.
 */
function resolveControlledOutputSource(sourceUrl, config = {}) {
  const raw = String(sourceUrl || '').trim();
  if (!raw || !config.OUTPUT_DIR) return null;
  let pathname = raw;
  if (/^https?:\/\//i.test(raw)) {
    let parsed;
    try { parsed = new URL(raw); } catch (_) { return null; }
    if (!isLoopbackHostname(parsed.hostname)) return null;
    pathname = parsed.pathname;
  } else {
    pathname = raw.split(/[?#]/, 1)[0];
  }
  const prefix = ['/files/output/', '/output/'].find((candidate) => pathname.startsWith(candidate));
  if (!prefix) return null;
  const encodedSegments = pathname.slice(prefix.length).split('/');
  if (!encodedSegments.length || encodedSegments.some((segment) => !segment)) {
    return { controlled: true, safe: false };
  }
  let segments;
  try { segments = encodedSegments.map((segment) => decodeURIComponent(segment)); } catch (_) {
    return { controlled: true, safe: false };
  }
  if (segments.some((segment) => !segment || segment === '.' || segment === '..' || /[\\/\0:]/.test(segment))) {
    return { controlled: true, safe: false };
  }
  const root = path.resolve(config.OUTPUT_DIR);
  const absolute = path.resolve(root, ...segments);
  if (!isPathInside(root, absolute)) return { controlled: true, safe: false };
  try {
    const realRoot = fs.realpathSync.native(root);
    const existingAnchor = nearestExistingPath(absolute);
    if (!existingAnchor) return { controlled: true, safe: false };
    const realAnchor = fs.realpathSync.native(existingAnchor);
    if (realAnchor !== realRoot && !isPathInside(realRoot, realAnchor)) return { controlled: true, safe: false };
    const exists = fs.existsSync(absolute);
    const isFile = exists && fs.statSync(absolute).isFile();
    if (exists && !isFile) return { controlled: true, safe: false };
    const anchoredAbsolute = path.resolve(realAnchor, path.relative(existingAnchor, absolute));
    if (!isPathInside(realRoot, anchoredAbsolute)) return { controlled: true, safe: false };
    return {
      controlled: true,
      safe: true,
      exists,
      absolute: anchoredAbsolute,
      relativePath: segments.join(path.sep),
      sourceUrl: `/files/output/${segments.map(encodeURIComponent).join('/')}`,
    };
  } catch (_) {
    return { controlled: true, safe: false };
  }
}

function hashFile(filename) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filename);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', () => resolve(hash.digest('hex')));
  });
}

function runFfprobe(filename) {
  return new Promise((resolve, reject) => {
    execFile(resolveBundledFfprobe(), [
      '-v', 'error', '-count_frames', '-show_format', '-show_streams', '-of', 'json', filename,
    ], { windowsHide: true, timeout: 45_000, maxBuffer: 3 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) return reject(new Error(String(stderr || error.message).trim().slice(0, 500)));
      try { resolve(JSON.parse(stdout || '{}')); } catch (parseError) { reject(parseError); }
    });
  });
}

function runFfprobeKeyframes(filename) {
  return new Promise((resolve, reject) => {
    execFile(resolveBundledFfprobe(), [
      '-v', 'error', '-select_streams', 'v:0', '-skip_frame', 'nokey', '-show_frames',
      '-show_entries', 'frame=key_frame,best_effort_timestamp_time,pkt_pts_time', '-of', 'json', filename,
    ], { windowsHide: true, timeout: 45_000, maxBuffer: 3 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) return reject(new Error(String(stderr || error.message).trim().slice(0, 500)));
      try {
        const parsed = JSON.parse(stdout || '{}');
        const timestamps = (Array.isArray(parsed.frames) ? parsed.frames : [])
          .filter((frame) => Number(frame?.key_frame) === 1)
          .map((frame) => Number(frame.best_effort_timestamp_time ?? frame.pkt_pts_time))
          .filter((value) => Number.isFinite(value) && value >= 0);
        resolve([...new Set(timestamps.map((value) => Number(value.toFixed(6))))].sort((a, b) => a - b));
      } catch (parseError) {
        reject(parseError);
      }
    });
  });
}

function runFfmpeg(args, timeout = 90_000) {
  return new Promise((resolve, reject) => {
    execFile(resolveBundledFfmpeg(), ['-hide_banner', '-loglevel', 'error', '-y', ...args], { windowsHide: true, timeout, maxBuffer: 3 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) return reject(new Error(String(stderr || error.message).trim().slice(0, 500)));
      resolve(stdout);
    });
  });
}

function publicThumbnailUrl(filename, config = {}) {
  const root = config.THUMBNAILS_DIR ? path.resolve(config.THUMBNAILS_DIR) : null;
  const absolute = path.resolve(filename);
  const relative = root && (absolute === root || absolute.startsWith(`${root}${path.sep}`))
    ? path.relative(root, absolute)
    : path.basename(absolute);
  return `/files/thumbnails/${relative.split(path.sep).map(encodeURIComponent).join('/')}`;
}

function temporarySibling(target) {
  const parsed = path.parse(target);
  return path.join(parsed.dir, `${parsed.name}.part-${process.pid}-${crypto.randomBytes(5).toString('hex')}${parsed.ext}`);
}

async function writeAtomicTarget(target, writer) {
  if (fs.existsSync(target)) return target;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = temporarySibling(target);
  try {
    await writer(temporary);
    if (!fs.existsSync(temporary)) throw new Error('预览生成器未写入临时文件');
    if (fs.existsSync(target)) fs.rmSync(temporary, { force: true });
    else fs.renameSync(temporary, target);
    return target;
  } finally {
    try { if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true }); } catch (_) {}
  }
}

function selectBoundedTimestamps(timestamps, maximum = 12) {
  const values = [...new Set((Array.isArray(timestamps) ? timestamps : []).filter((value) => Number.isFinite(value) && value >= 0))].sort((a, b) => a - b);
  if (values.length <= maximum) return values;
  return Array.from({ length: maximum }, (_, index) => values[Math.round((index * (values.length - 1)) / (maximum - 1))]);
}

const EXIF_IFD0_TAGS = Object.freeze({
  0x010E: 'imageDescription', 0x010F: 'make', 0x0110: 'model', 0x0112: 'orientation',
  0x011A: 'xResolution', 0x011B: 'yResolution', 0x0128: 'resolutionUnit', 0x0131: 'software',
  0x0132: 'dateTime', 0x013B: 'artist', 0x8298: 'copyright',
});
const EXIF_SUBIFD_TAGS = Object.freeze({
  0x829A: 'exposureTime', 0x829D: 'fNumber', 0x8822: 'exposureProgram', 0x8827: 'iso',
  0x9000: 'exifVersion', 0x9003: 'dateTimeOriginal', 0x9004: 'dateTimeDigitized',
  0x9204: 'exposureBias', 0x9207: 'meteringMode', 0x9209: 'flash', 0x920A: 'focalLength',
  0xA001: 'colorSpace', 0xA002: 'pixelWidth', 0xA003: 'pixelHeight', 0xA402: 'exposureMode',
  0xA403: 'whiteBalance', 0xA405: 'focalLength35mm', 0xA432: 'lensSpecification',
  0xA433: 'lensMake', 0xA434: 'lensModel',
});

function parseExifBuffer(raw) {
  if (!Buffer.isBuffer(raw) || raw.length < 8) return {};
  const tiffStart = raw.subarray(0, 6).toString('ascii') === 'Exif\0\0' ? 6 : 0;
  if (raw.length < tiffStart + 8) return {};
  const byteOrder = raw.toString('ascii', tiffStart, tiffStart + 2);
  const littleEndian = byteOrder === 'II';
  if (!littleEndian && byteOrder !== 'MM') return {};
  const uint16 = (offset) => {
    if (offset < 0 || offset + 2 > raw.length) throw new Error('EXIF SHORT 越界');
    return littleEndian ? raw.readUInt16LE(offset) : raw.readUInt16BE(offset);
  };
  const uint32 = (offset) => {
    if (offset < 0 || offset + 4 > raw.length) throw new Error('EXIF LONG 越界');
    return littleEndian ? raw.readUInt32LE(offset) : raw.readUInt32BE(offset);
  };
  const int32 = (offset) => {
    if (offset < 0 || offset + 4 > raw.length) throw new Error('EXIF SLONG 越界');
    return littleEndian ? raw.readInt32LE(offset) : raw.readInt32BE(offset);
  };
  if (uint16(tiffStart + 2) !== 42) return {};
  const typeSize = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };
  const readValue = (entryOffset, type, count) => {
    const size = typeSize[type] || 0;
    if (!size || count < 1 || count > 1024 || size * count > 8192) return undefined;
    const byteLength = size * count;
    const valueOffset = byteLength <= 4 ? entryOffset + 8 : tiffStart + uint32(entryOffset + 8);
    if (valueOffset < 0 || valueOffset + byteLength > raw.length) return undefined;
    if (type === 2) return raw.toString('utf8', valueOffset, valueOffset + byteLength).replace(/\0+$/g, '').trim().slice(0, 500);
    if (type === 7) return raw.subarray(valueOffset, valueOffset + byteLength).toString('ascii').replace(/\0+$/g, '').trim().slice(0, 100);
    const values = [];
    for (let index = 0; index < Math.min(count, 16); index += 1) {
      const offset = valueOffset + index * size;
      if (type === 1) values.push(raw[offset]);
      else if (type === 3) values.push(uint16(offset));
      else if (type === 4) values.push(uint32(offset));
      else if (type === 9) values.push(int32(offset));
      else if (type === 5 || type === 10) {
        const numerator = type === 5 ? uint32(offset) : int32(offset);
        const denominator = type === 5 ? uint32(offset + 4) : int32(offset + 4);
        values.push(denominator ? numerator / denominator : null);
      }
    }
    return count === 1 ? values[0] : values;
  };
  const readIfd = (relativeOffset, tags) => {
    const output = {};
    const absolute = tiffStart + Number(relativeOffset || 0);
    if (absolute < tiffStart || absolute + 2 > raw.length) return output;
    const entries = Math.min(256, uint16(absolute));
    for (let index = 0; index < entries; index += 1) {
      const entryOffset = absolute + 2 + index * 12;
      if (entryOffset + 12 > raw.length) break;
      const tag = uint16(entryOffset);
      const name = tags[tag];
      if (!name) continue;
      const value = readValue(entryOffset, uint16(entryOffset + 2), uint32(entryOffset + 4));
      if (value !== undefined && value !== '') output[name] = value;
    }
    return output;
  };
  try {
    const ifd0Offset = uint32(tiffStart + 4);
    const ifd0 = readIfd(ifd0Offset, EXIF_IFD0_TAGS);
    const ifd0Absolute = tiffStart + ifd0Offset;
    const entries = Math.min(256, uint16(ifd0Absolute));
    let exifOffset = 0;
    for (let index = 0; index < entries; index += 1) {
      const entryOffset = ifd0Absolute + 2 + index * 12;
      if (entryOffset + 12 > raw.length) break;
      if (uint16(entryOffset) === 0x8769) { exifOffset = uint32(entryOffset + 8); break; }
    }
    const exif = exifOffset ? readIfd(exifOffset, EXIF_SUBIFD_TAGS) : {};
    return { ...ifd0, ...exif };
  } catch (_) {
    return {};
  }
}

function safeProbeTags(tags) {
  if (!tags || typeof tags !== 'object') return {};
  const allowed = new Set(['title', 'artist', 'album', 'album_artist', 'date', 'genre', 'comment', 'language', 'encoder', 'creation_time']);
  return Object.fromEntries(Object.entries(tags).filter(([key, value]) => allowed.has(String(key).toLowerCase()) && typeof value === 'string').slice(0, 30).map(([key, value]) => [key, value.slice(0, 500)]));
}

async function differenceHash(filename) {
  const input = fs.createReadStream(filename);
  const transformer = sharp({
    animated: false,
    failOn: 'error',
    limitInputPixels: MAX_IMAGE_INPUT_PIXELS,
  }).resize(9, 8, { fit: 'fill' }).greyscale().raw();
  input.once('error', (error) => transformer.destroy(error));
  input.pipe(transformer);
  let result;
  try {
    result = await transformer.toBuffer({ resolveWithObject: true });
  } finally {
    input.destroy();
    transformer.destroy();
  }
  const { data, info } = result;
  if (info.width !== 9 || info.height !== 8) return '';
  let bits = '';
  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 8; x += 1) bits += data[y * 9 + x] > data[y * 9 + x + 1] ? '1' : '0';
  }
  return BigInt(`0b${bits}`).toString(16).padStart(16, '0');
}

async function readOrientedGrayscale32(filename) {
  const input = fs.createReadStream(filename);
  const transformer = sharp({
    animated: false,
    failOn: 'error',
    limitInputPixels: MAX_IMAGE_INPUT_PIXELS,
  })
    .rotate()
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .resize(PHASH_SAMPLE_SIZE, PHASH_SAMPLE_SIZE, { fit: 'fill' })
    .greyscale()
    .raw();
  input.once('error', (error) => transformer.destroy(error));
  input.pipe(transformer);
  let result;
  try {
    result = await transformer.toBuffer({ resolveWithObject: true });
  } finally {
    input.destroy();
    transformer.destroy();
  }
  const { data, info } = result;
  if (info.width !== PHASH_SAMPLE_SIZE || info.height !== PHASH_SAMPLE_SIZE || info.channels !== 1 || data.length !== PHASH_SAMPLE_SIZE ** 2) {
    throw new Error('DCT pHash 灰度采样尺寸无效');
  }
  return data;
}

function dct64FromGrayscale32(grayscale) {
  if (!grayscale || grayscale.length !== PHASH_SAMPLE_SIZE ** 2) {
    throw new TypeError('DCT pHash 需要 32x32 灰度采样');
  }
  // Separable, orthonormal 2-D DCT-II. Only the upper-left 8x8
  // coefficients are materialized because the remaining frequencies do not
  // contribute to the 64-bit fingerprint.
  const horizontal = new Float64Array(PHASH_SAMPLE_SIZE * PHASH_LOW_FREQUENCY_SIZE);
  for (let y = 0; y < PHASH_SAMPLE_SIZE; y += 1) {
    for (let u = 0; u < PHASH_LOW_FREQUENCY_SIZE; u += 1) {
      let sum = 0;
      for (let x = 0; x < PHASH_SAMPLE_SIZE; x += 1) {
        sum += Number(grayscale[y * PHASH_SAMPLE_SIZE + x]) * PHASH_DCT_COSINES[u][x];
      }
      horizontal[y * PHASH_LOW_FREQUENCY_SIZE + u] = sum * PHASH_DCT_SCALES[u];
    }
  }
  const coefficients = new Float64Array(PHASH_LOW_FREQUENCY_SIZE ** 2);
  for (let v = 0; v < PHASH_LOW_FREQUENCY_SIZE; v += 1) {
    for (let u = 0; u < PHASH_LOW_FREQUENCY_SIZE; u += 1) {
      let sum = 0;
      for (let y = 0; y < PHASH_SAMPLE_SIZE; y += 1) {
        sum += horizontal[y * PHASH_LOW_FREQUENCY_SIZE + u] * PHASH_DCT_COSINES[v][y];
      }
      coefficients[v * PHASH_LOW_FREQUENCY_SIZE + u] = sum * PHASH_DCT_SCALES[v];
    }
  }
  // The DC coefficient participates as bit 0 so the result is exactly 64
  // bits, but it is excluded from the median to prevent global brightness
  // from setting the threshold for every low-frequency AC coefficient.
  const ac = Array.from(coefficients.subarray(1)).sort((left, right) => left - right);
  const median = ac[Math.floor(ac.length / 2)];
  let fingerprint = 0n;
  for (const coefficient of coefficients) {
    fingerprint = (fingerprint << 1n) | (coefficient > median ? 1n : 0n);
  }
  return fingerprint.toString(16).padStart(16, '0');
}

async function dctPerceptualHash(filename) {
  return dct64FromGrayscale32(await readOrientedGrayscale32(filename));
}

function safeExternalReference(root, reference) {
  const cleaned = String(reference || '').replace(/\\/g, '/');
  if (!cleaned) return { reference: cleaned, external: false, exists: true };
  if (/^data:/i.test(cleaned)) return { reference: 'data:embedded', external: false, exists: true, embedded: true };
  if (/^https?:/i.test(cleaned)) return { reference: cleaned, external: true, exists: false, unsafe: true, remote: true };
  const absolute = path.resolve(root, cleaned);
  const inside = absolute === root || absolute.startsWith(`${root}${path.sep}`);
  return { reference: cleaned, external: true, exists: inside && fs.existsSync(absolute), unsafe: !inside };
}

function boundedModelReference(value, limits, label) {
  if (typeof value !== 'string' || !value) return null;
  if (/^data:/i.test(value)) return value;
  if (Buffer.byteLength(value, 'utf8') > limits.maxReferenceBytes) {
    failModelMetadata('MODEL_METADATA_TOO_COMPLEX', `${label}长度超过 ${limits.maxReferenceBytes} bytes`);
  }
  return value;
}

function validateGltfCollections(document, limits) {
  const collectionNames = ['accessors', 'animations', 'buffers', 'bufferViews', 'images', 'materials', 'meshes', 'nodes', 'samplers', 'scenes', 'skins', 'textures'];
  let totalEntries = 0;
  for (const name of collectionNames) {
    const collection = document[name];
    if (collection == null) continue;
    if (!Array.isArray(collection)) failModelMetadata('INVALID_MODEL_METADATA', `glTF ${name} 必须是数组`);
    totalEntries += collection.length;
    if (totalEntries > limits.maxGltfEntries) failModelMetadata('MODEL_METADATA_TOO_COMPLEX', `glTF 结构条目超过 ${limits.maxGltfEntries}`);
  }
}

function parseGlbJsonDocument(filename, limits) {
  const stat = statBoundedModelFile(filename, limits.maxSourceBytes, 'GLB 文件');
  const descriptor = fs.openSync(path.resolve(filename), 'r');
  try {
    if (stat.size < 20) failModelMetadata('INVALID_MODEL_METADATA', '无效 GLB 文件头');
    const header = readExactSync(descriptor, 12, 0, 'GLB 文件头');
    if (header.readUInt32LE(0) !== 0x46546C67) failModelMetadata('INVALID_MODEL_METADATA', '无效 GLB 文件头');
    if (header.readUInt32LE(4) !== 2) failModelMetadata('INVALID_MODEL_METADATA', '仅支持 GLB 2.0');
    if (header.readUInt32LE(8) !== stat.size) failModelMetadata('INVALID_MODEL_METADATA', 'GLB 声明长度与文件不一致');
    let document;
    let offset = 12;
    let chunks = 0;
    while (offset < stat.size) {
      chunks += 1;
      if (chunks > limits.maxGlbChunks) failModelMetadata('MODEL_METADATA_TOO_COMPLEX', `GLB chunk 数超过 ${limits.maxGlbChunks}`);
      if (offset + 8 > stat.size) failModelMetadata('INVALID_MODEL_METADATA', 'GLB chunk header 被截断');
      const chunkHeader = readExactSync(descriptor, 8, offset, 'GLB chunk header');
      const chunkLength = chunkHeader.readUInt32LE(0);
      const chunkType = chunkHeader.readUInt32LE(4);
      const chunkStart = offset + 8;
      const chunkEnd = chunkStart + chunkLength;
      if (!Number.isSafeInteger(chunkEnd) || chunkEnd > stat.size) failModelMetadata('INVALID_MODEL_METADATA', 'GLB chunk 数据越界');
      if (chunkType === 0x4E4F534A && !document) {
        if (chunkLength > limits.maxJsonBytes) failModelMetadata('MODEL_METADATA_TOO_COMPLEX', `GLB JSON 超过 ${limits.maxJsonBytes} bytes`);
        const json = readExactSync(descriptor, chunkLength, chunkStart, 'GLB JSON');
        try {
          document = JSON.parse(json.toString('utf8').replace(/[\0\s]+$/g, ''));
        } catch (_) {
          failModelMetadata('INVALID_MODEL_METADATA', 'GLB JSON 无法解析');
        }
      }
      offset = chunkEnd;
    }
    if (!document || typeof document !== 'object' || Array.isArray(document)) failModelMetadata('INVALID_MODEL_METADATA', '缺少 glTF JSON 数据');
    return document;
  } finally {
    fs.closeSync(descriptor);
  }
}

function parseGltfDocument(filename, options = {}) {
  const limits = normalizeModelMetadataLimits(options);
  const extension = path.extname(filename).toLowerCase();
  let document;
  if (extension === '.gltf') {
    const stat = statBoundedModelFile(filename, Math.min(limits.maxSourceBytes, limits.maxJsonBytes), 'glTF JSON');
    const descriptor = fs.openSync(path.resolve(filename), 'r');
    try {
      const raw = readExactSync(descriptor, stat.size, 0, 'glTF JSON');
      if (raw.includes(0)) failModelMetadata('INVALID_MODEL_METADATA', 'glTF JSON 包含无效二进制数据');
      try { document = JSON.parse(raw.toString('utf8')); } catch (_) { failModelMetadata('INVALID_MODEL_METADATA', 'glTF JSON 无法解析'); }
    } finally {
      fs.closeSync(descriptor);
    }
  } else if (extension === '.glb') document = parseGlbJsonDocument(filename, limits);
  else failModelMetadata('INVALID_MODEL_METADATA', '仅支持 glTF 或 GLB 元数据解析');
  if (!document || typeof document !== 'object' || Array.isArray(document)) failModelMetadata('INVALID_MODEL_METADATA', '缺少 glTF JSON 数据');
  validateGltfCollections(document, limits);
  const root = path.dirname(path.resolve(filename));
  const references = [];
  const appendReferences = (collection, kind) => {
    for (let index = 0; index < collection.length; index += 1) {
      const uri = boundedModelReference(collection[index]?.uri, limits, `glTF ${kind} 引用`);
      if (!uri) continue;
      if (references.length >= limits.maxReferences) failModelMetadata('MODEL_METADATA_TOO_COMPLEX', `glTF 外部引用超过 ${limits.maxReferences}`);
      references.push({ ...safeExternalReference(root, uri), kind, index });
    }
  };
  appendReferences(document.buffers || [], 'buffer');
  appendReferences(document.images || [], 'texture');
  let bounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  for (const accessor of document.accessors || []) {
    if (accessor?.type !== 'VEC3' || !Array.isArray(accessor.min) || !Array.isArray(accessor.max) || accessor.min.length < 3 || accessor.max.length < 3) continue;
    const minimum = accessor.min.slice(0, 3).map(Number);
    const maximum = accessor.max.slice(0, 3).map(Number);
    if (![...minimum, ...maximum].every(Number.isFinite)) continue;
    bounds = {
      min: bounds.min.map((entry, index) => Math.min(entry, minimum[index])),
      max: bounds.max.map((entry, index) => Math.max(entry, maximum[index])),
    };
  }
  let primitives = 0;
  let vertices = 0;
  let triangles = 0;
  for (const mesh of document.meshes || []) {
    if (mesh?.primitives != null && !Array.isArray(mesh.primitives)) failModelMetadata('INVALID_MODEL_METADATA', 'glTF mesh primitives 必须是数组');
    primitives += mesh?.primitives?.length || 0;
    if (primitives > limits.maxTriangles) failModelMetadata('MODEL_METADATA_TOO_COMPLEX', `glTF primitive 数超过 ${limits.maxTriangles}`);
    for (const primitive of mesh?.primitives || []) {
      if (primitive?.mode != null && primitive.mode !== 4) continue;
      const positionIndex = primitive?.attributes?.POSITION;
      if (positionIndex == null) continue;
      if (!Number.isSafeInteger(positionIndex) || !document.accessors?.[positionIndex]) failModelMetadata('INVALID_MODEL_METADATA', 'glTF POSITION accessor 无效');
      const positionAccessor = document.accessors[positionIndex];
      const positionCount = Number(positionAccessor.count);
      if (positionAccessor.type !== 'VEC3' || !Number.isSafeInteger(positionCount) || positionCount < 1 || positionCount > limits.maxVertices) {
        failModelMetadata('MODEL_TOO_COMPLEX', `glTF POSITION 顶点数量无效或超过 ${limits.maxVertices}`);
      }
      vertices += positionCount;
      if (vertices > limits.maxVertices) failModelMetadata('MODEL_TOO_COMPLEX', `glTF 顶点总数超过 ${limits.maxVertices}`);
      let indexCount = positionCount;
      if (primitive.indices != null) {
        if (!Number.isSafeInteger(primitive.indices) || !document.accessors?.[primitive.indices]) failModelMetadata('INVALID_MODEL_METADATA', 'glTF 索引 accessor 无效');
        indexCount = Number(document.accessors[primitive.indices].count);
      }
      if (!Number.isSafeInteger(indexCount) || indexCount < 3 || indexCount % 3 !== 0 || indexCount > limits.maxTriangles * 3) {
        failModelMetadata('MODEL_TOO_COMPLEX', 'glTF 三角面索引数量无效或超限');
      }
      triangles += indexCount / 3;
      if (triangles > limits.maxTriangles) failModelMetadata('MODEL_TOO_COMPLEX', `glTF 三角面超过 ${limits.maxTriangles}`);
    }
  }
  return {
    format: extension.slice(1), version: document.asset?.version, generator: document.asset?.generator,
    scenes: document.scenes?.length || 0, nodes: document.nodes?.length || 0, meshes: document.meshes?.length || 0,
    primitives, vertices, triangles, materials: document.materials?.length || 0,
    textures: document.textures?.length || 0, animations: document.animations?.length || 0, skins: document.skins?.length || 0,
    bounds: Number.isFinite(bounds.min[0]) ? bounds : null,
    references,
    textureReferences: references.filter((item) => item.kind === 'texture'),
    missingReferences: references.filter((item) => item.external && !item.exists).map((item) => item.reference),
  };
}

function parseObjMetadata(filename, options = {}) {
  const limits = normalizeModelMetadataLimits(options);
  const root = path.dirname(path.resolve(filename));
  let vertices = 0;
  let faces = 0;
  let triangles = 0;
  const bounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  const references = [];
  const textureReferences = [];
  scanUtf8LinesSync(filename, { limits, label: 'OBJ 文件' }, (rawLine) => {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) return;
    const parts = line.split(/\s+/);
    if (parts[0] === 'v') {
      if (parts.length < 4) failModelMetadata('INVALID_MODEL_METADATA', 'OBJ 顶点数据不完整');
      const vertex = parts.slice(1, 4).map(Number);
      if (!vertex.every(Number.isFinite)) failModelMetadata('INVALID_MODEL_METADATA', 'OBJ 顶点包含非有限数值');
      vertices += 1;
      if (vertices > limits.maxVertices) failModelMetadata('MODEL_TOO_COMPLEX', `OBJ 顶点超过 ${limits.maxVertices}`);
      bounds.min = bounds.min.map((entry, index) => Math.min(entry, vertex[index]));
      bounds.max = bounds.max.map((entry, index) => Math.max(entry, vertex[index]));
    } else if (parts[0] === 'f') {
      const faceVertices = parts.length - 1;
      if (faceVertices < 3) failModelMetadata('INVALID_MODEL_METADATA', 'OBJ 面数据不完整');
      if (faceVertices > limits.maxFaceVertices) failModelMetadata('MODEL_TOO_COMPLEX', `OBJ 单面顶点超过 ${limits.maxFaceVertices}`);
      faces += 1;
      triangles += faceVertices - 2;
      if (triangles > limits.maxTriangles) failModelMetadata('MODEL_TOO_COMPLEX', `OBJ 三角面超过 ${limits.maxTriangles}`);
    } else if (parts[0] === 'mtllib' && parts[1]) {
      if (references.length >= limits.maxMaterialLibraries) failModelMetadata('MODEL_METADATA_TOO_COMPLEX', `OBJ 材质库超过 ${limits.maxMaterialLibraries}`);
      const reference = boundedModelReference(parts.slice(1).join(' '), limits, 'OBJ 材质库引用');
      references.push({ ...safeExternalReference(root, reference), kind: 'material-library' });
    }
  });
  let totalMaterialBytes = 0;
  const visitedMaterials = new Set();
  for (const material of [...references]) {
    if (!material.exists || material.unsafe) continue;
    const materialPath = path.resolve(root, material.reference);
    const materialKey = materialPath.toLowerCase();
    if (visitedMaterials.has(materialKey)) continue;
    visitedMaterials.add(materialKey);
    let materialStat;
    try { materialStat = fs.statSync(materialPath); } catch (_) { continue; }
    if (!materialStat.isFile()) continue;
    if (materialStat.size > limits.maxMtlBytes) failModelMetadata('MODEL_METADATA_TOO_COMPLEX', `MTL 文件超过 ${limits.maxMtlBytes} bytes`);
    totalMaterialBytes += materialStat.size;
    if (totalMaterialBytes > limits.maxMtlTotalBytes) failModelMetadata('MODEL_METADATA_TOO_COMPLEX', `MTL 总大小超过 ${limits.maxMtlTotalBytes} bytes`);
    const materialRoot = path.dirname(materialPath);
    scanUtf8LinesSync(materialPath, { limits, maximumBytes: limits.maxMtlBytes, label: 'MTL 文件' }, (rawLine) => {
      const parts = rawLine.replace(/#.*$/, '').trim().split(/\s+/);
      if (!/^(?:map_(?:Ka|Kd|Ks|Ke|Ns|d|bump)|bump|disp|decal|norm)$/i.test(parts[0] || '') || parts.length < 2) return;
      if (references.length + textureReferences.length >= limits.maxReferences) failModelMetadata('MODEL_METADATA_TOO_COMPLEX', `OBJ/MTL 引用超过 ${limits.maxReferences}`);
      const reference = boundedModelReference(parts.at(-1), limits, 'MTL 贴图引用');
      textureReferences.push({ ...safeExternalReference(materialRoot, reference), kind: 'texture', mapType: parts[0] });
    });
  }
  references.push(...textureReferences);
  return { format: 'obj', vertices, faces, triangles, bounds: vertices ? bounds : null, references, textureReferences, missingReferences: references.filter((item) => !item.exists).map((item) => item.reference) };
}

async function createDerivedMedia(filename, kind, metadata, config, contentHash) {
  if (!config.THUMBNAILS_DIR || !['image', 'video', 'audio', 'model3d'].includes(kind)) return {};
  const previewRoot = config.ASSET_PREVIEWS_DIR || config.THUMBNAILS_DIR;
  fs.mkdirSync(previewRoot, { recursive: true });
  const pipelineVersion = String(config.ASSET_PREVIEW_PIPELINE_VERSION || DEFAULT_ASSET_PREVIEW_PIPELINE_VERSION)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || DEFAULT_ASSET_PREVIEW_PIPELINE_VERSION;
  // Include the pipeline version in every cache path so a pipeline upgrade cannot
  // accidentally reuse an older or partially compatible derived artifact.
  const prefix = `asset-${contentHash.slice(0, 24)}-${pipelineVersion}`;
  if (kind === 'image') {
    const target = path.join(previewRoot, `${prefix}-thumb.webp`);
    await writeAtomicTarget(target, async (temporary) => {
      await sharp(filename, { animated: false, failOn: 'error', limitInputPixels: MAX_IMAGE_INPUT_PIXELS })
        .rotate()
        .resize(480, 480, { fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 78 })
        .toFile(temporary);
    });
    const perceptualHash = await dctPerceptualHash(filename);
    return {
      previewStatus: 'ready',
      thumbnailUrl: publicThumbnailUrl(target, config),
      perceptualHash,
      perceptualHashAlgorithm: PHASH_DCT64_ALGORITHM,
      perceptualHashes: [{
        role: 'primary',
        index: 0,
        hash: perceptualHash,
        algorithm: PHASH_DCT64_ALGORITHM,
      }],
    };
  }
  if (kind === 'video') {
    const duration = Math.max(0, Number(metadata.duration) || 0);
    const keyframeTimes = selectBoundedTimestamps(await runFfprobeKeyframes(filename), 12);
    if (!keyframeTimes.length) throw new Error('视频未找到可验证的 codec 关键帧');
    const first = path.join(previewRoot, `${prefix}-first.webp`);
    const last = path.join(previewRoot, `${prefix}-last.webp`);
    const contact = path.join(previewRoot, `${prefix}-contact.webp`);
    const proxy = path.join(previewRoot, `${prefix}-proxy.mp4`);
    await writeAtomicTarget(first, (temporary) => runFfmpeg(['-ss', '0', '-i', filename, '-frames:v', '1', '-vf', 'scale=480:-2', '-c:v', 'libwebp', '-quality', '75', temporary]));
    await writeAtomicTarget(last, (temporary) => runFfmpeg(['-ss', String(Math.max(0, duration - 0.08)), '-i', filename, '-frames:v', '1', '-vf', 'scale=480:-2', '-c:v', 'libwebp', '-quality', '75', temporary]));
    await writeAtomicTarget(contact, async (temporary) => {
      const interval = Math.max(0.1, duration / 6 || 1);
      await runFfmpeg(['-i', filename, '-vf', `fps=1/${interval},scale=240:-2,tile=3x2`, '-frames:v', '1', '-c:v', 'libwebp', '-quality', '75', temporary]);
    });
    await writeAtomicTarget(proxy, (temporary) => runFfmpeg([
      '-i', filename,
      '-map', '0:v:0', '-map', '0:a:0?',
      '-vf', "scale=w='trunc(min(1280,iw)/2)*2':h=-2",
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', temporary,
    ], 10 * 60_000));
    const keyframes = [];
    const perceptualHashes = [];
    for (let index = 0; index < keyframeTimes.length; index += 1) {
      const target = path.join(previewRoot, `${prefix}-keyframe-${String(index + 1).padStart(2, '0')}.webp`);
      await writeAtomicTarget(target, (temporary) => runFfmpeg([
        '-ss', String(keyframeTimes[index]), '-i', filename, '-frames:v', '1', '-vf', 'scale=480:-2',
        '-c:v', 'libwebp', '-quality', '75', temporary,
      ]));
      keyframes.push(publicThumbnailUrl(target, config));
      perceptualHashes.push({
        role: 'codec-keyframe',
        index,
        time: keyframeTimes[index],
        hash: await dctPerceptualHash(target),
        algorithm: PHASH_DCT64_ALGORITHM,
      });
    }
    return {
      previewStatus: 'ready',
      thumbnailUrl: publicThumbnailUrl(first, config),
      firstFrameUrl: publicThumbnailUrl(first, config),
      lastFrameUrl: publicThumbnailUrl(last, config),
      keyframeUrls: keyframes,
      keyframeTimes,
      contactSheetUrl: publicThumbnailUrl(contact, config),
      proxyUrl: publicThumbnailUrl(proxy, config),
      perceptualHash: perceptualHashes[0].hash,
      perceptualHashAlgorithm: PHASH_DCT64_ALGORITHM,
      perceptualHashes,
    };
  }
  if (kind === 'audio') {
    const waveform = path.join(previewRoot, `${prefix}-waveform.png`);
    await writeAtomicTarget(waveform, (temporary) => runFfmpeg(['-i', filename, '-filter_complex', 'aformat=channel_layouts=mono,showwavespic=s=960x180:colors=36cfc9', '-frames:v', '1', temporary]));
    return { previewStatus: 'ready', waveformUrl: publicThumbnailUrl(waveform, config) };
  }
  const target = path.join(previewRoot, `${prefix}-model.webp`);
  await writeAtomicTarget(target, async (temporary) => {
    const { renderModelPreview } = require('./modelPreviewRenderer');
    if (typeof renderModelPreview !== 'function') throw new Error('3D 预览渲染器不可用');
    await renderModelPreview({ sourcePath: filename, targetPath: temporary, width: 480, height: 480 });
  });
  const modelPreviewUrl = publicThumbnailUrl(target, config);
  return { previewStatus: 'ready', thumbnailUrl: modelPreviewUrl, modelPreviewUrl };
}

function parseRatio(value) {
  const match = String(value || '').match(/^(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/);
  if (!match) return Number(value) || 0;
  return Number(match[2]) ? Number(match[1]) / Number(match[2]) : 0;
}

async function readMetadata(filename, kind, stat, options = {}) {
  const base = { size: stat.size, modifiedAt: stat.mtimeMs };
  if (kind === 'image') {
    const info = await sharp(filename, {
      animated: true,
      failOn: 'error',
      limitInputPixels: MAX_IMAGE_INPUT_PIXELS,
    }).metadata();
    const exif = parseExifBuffer(info.exif);
    return {
      ...base,
      width: info.width,
      height: info.height,
      format: info.format,
      space: info.space,
      channels: info.channels,
      depth: info.depth,
      density: info.density,
      orientation: info.orientation,
      chromaSubsampling: info.chromaSubsampling,
      isProgressive: info.isProgressive,
      pages: info.pages || 1,
      hasAlpha: info.hasAlpha,
      hasIccProfile: Boolean(info.icc),
      hasExif: Boolean(info.exif),
      colorProfile: {
        space: info.space || null,
        depth: info.depth || null,
        channels: Number(info.channels) || null,
        chromaSubsampling: info.chromaSubsampling || null,
        iccBytes: Buffer.isBuffer(info.icc) ? info.icc.length : 0,
      },
      exif,
    };
  }
  if (kind === 'video' || kind === 'audio') {
    const probe = await runFfprobe(filename);
    const streams = Array.isArray(probe.streams) ? probe.streams : [];
    const video = streams.find((stream) => stream.codec_type === 'video');
    const audio = streams.find((stream) => stream.codec_type === 'audio');
    return {
      ...base,
      duration: Number(probe.format?.duration || video?.duration || audio?.duration) || 0,
      bitrate: Number(probe.format?.bit_rate) || 0,
      formatName: probe.format?.format_name,
      formatLongName: probe.format?.format_long_name,
      startTime: Number(probe.format?.start_time) || 0,
      streamCount: streams.length,
      videoStreamCount: streams.filter((stream) => stream.codec_type === 'video').length,
      audioStreamCount: streams.filter((stream) => stream.codec_type === 'audio').length,
      tags: safeProbeTags(probe.format?.tags),
      width: Number(video?.width) || undefined,
      height: Number(video?.height) || undefined,
      frameRate: video ? parseRatio(video.avg_frame_rate || video.r_frame_rate) : undefined,
      frameCount: Number(video?.nb_read_frames || video?.nb_frames) || undefined,
      rotation: Number(video?.tags?.rotate || video?.side_data_list?.find((item) => Number.isFinite(Number(item.rotation)))?.rotation) || 0,
      videoCodec: video?.codec_name,
      videoCodecLongName: video?.codec_long_name,
      videoProfile: video?.profile,
      videoLevel: Number(video?.level) || undefined,
      videoBitrate: Number(video?.bit_rate) || undefined,
      videoTimeBase: video?.time_base,
      videoStartTime: Number(video?.start_time) || undefined,
      videoDuration: Number(video?.duration) || undefined,
      pixelFormat: video?.pix_fmt,
      bitsPerRawSample: Number(video?.bits_per_raw_sample) || undefined,
      sampleAspectRatio: video?.sample_aspect_ratio,
      displayAspectRatio: video?.display_aspect_ratio,
      fieldOrder: video?.field_order,
      colorRange: video?.color_range,
      colorPrimaries: video?.color_primaries,
      colorSpace: video?.color_space,
      colorTransfer: video?.color_transfer,
      audioCodec: audio?.codec_name,
      audioCodecLongName: audio?.codec_long_name,
      audioProfile: audio?.profile,
      audioBitrate: Number(audio?.bit_rate) || undefined,
      audioTimeBase: audio?.time_base,
      audioStartTime: Number(audio?.start_time) || undefined,
      audioDuration: Number(audio?.duration) || undefined,
      sampleRate: Number(audio?.sample_rate) || undefined,
      channels: Number(audio?.channels) || undefined,
      channelLayout: audio?.channel_layout,
      sampleFormat: audio?.sample_fmt,
      bitsPerSample: Number(audio?.bits_per_sample) || undefined,
      audioBitsPerRawSample: Number(audio?.bits_per_raw_sample) || undefined,
      audioTags: safeProbeTags(audio?.tags),
    };
  }
  if (kind === 'model3d') {
    const extension = String(options.sourceExtension || path.extname(filename)).toLowerCase();
    const limits = normalizeModelMetadataLimits(options.modelMetadataLimits || options);
    statBoundedModelFile(filename, limits.maxSourceBytes, '3D 模型');
    if (extension === '.gltf' || extension === '.glb') return { ...base, ...parseGltfDocument(filename, limits) };
    if (extension === '.obj') return { ...base, ...parseObjMetadata(filename, limits) };
    return { ...base, format: extension.slice(1), previewStatus: 'unsupported', health: 'unverified' };
  }
  if (kind === 'text' && stat.size <= 512 * 1024) {
    const preview = fs.readFileSync(filename, 'utf8').replace(/\s+/g, ' ').trim().slice(0, 1000);
    return { ...base, preview };
  }
  return base;
}

function sourceStatIdentity(stat) {
  return {
    dev: Number(stat?.dev) || 0,
    ino: Number(stat?.ino) || 0,
    mode: Number(stat?.mode) || 0,
    size: Number(stat?.size) || 0,
    mtimeMs: Number(stat?.mtimeMs) || 0,
    ctimeMs: Number(stat?.ctimeMs) || 0,
  };
}

function sameSourceStat(left, right) {
  const a = sourceStatIdentity(left);
  const b = sourceStatIdentity(right);
  return a.dev === b.dev
    && a.ino === b.ino
    && a.mode === b.mode
    && a.size === b.size
    && a.mtimeMs === b.mtimeMs
    && a.ctimeMs === b.ctimeMs;
}

function sourceChangedError() {
  const error = new Error('素材在索引期间发生变化，请等待写入完成后重试');
  error.code = 'ASSET_SOURCE_CHANGED';
  error.retryable = true;
  return error;
}

async function readStableAssetSource(filename, kind, options = {}) {
  const absolute = path.resolve(filename);
  const attempts = Math.max(1, Math.min(3, Number(options.attempts) || 2));
  const hashReader = typeof options.hashFile === 'function' ? options.hashFile : hashFile;
  const metadataReader = typeof options.readMetadata === 'function' ? options.readMetadata : readMetadata;
  const buildDerived = typeof options.buildDerived === 'function' ? options.buildDerived : null;
  let lastChange = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let before;
    try {
      before = fs.statSync(absolute);
      if (!before.isFile()) throw new Error('素材路径不是文件');
      const firstHash = await hashReader(absolute);
      let metadata;
      try {
        metadata = await metadataReader(absolute, kind, before, options.metadataOptions || {});
      } catch (error) {
        metadata = {
          size: before.size,
          modifiedAt: before.mtimeMs,
          health: 'corrupt',
          metadataErrorCode: String(error?.code || 'METADATA_READ_FAILED').slice(0, 100),
          metadataError: String(error?.message || error || '元数据读取失败').replace(/\s+/g, ' ').trim().slice(0, 600),
        };
      }
      if (!metadata.health) {
        metadata.health = Array.isArray(metadata.missingReferences) && metadata.missingReferences.length
          ? 'missing-dependencies'
          : 'ok';
      }
      if (buildDerived) {
        if (metadata.health === 'corrupt') {
          metadata.previewStatus = 'failed';
          metadata.previewError = metadata.metadataError || '素材损坏，未生成预览';
        } else {
          try {
            metadata = { ...metadata, ...await buildDerived({ filename: absolute, kind, metadata, contentHash: firstHash }) };
          } catch (error) {
            metadata.previewStatus = 'failed';
            metadata.previewError = error?.message || String(error);
          }
        }
      }

      const afterMetadata = fs.statSync(absolute);
      if (!afterMetadata.isFile() || !sameSourceStat(before, afterMetadata)) {
        lastChange = sourceChangedError();
        continue;
      }
      const secondHash = await hashReader(absolute);
      const afterHash = fs.statSync(absolute);
      if (!afterHash.isFile()
        || !sameSourceStat(before, afterHash)
        || firstHash !== secondHash) {
        lastChange = sourceChangedError();
        continue;
      }
      return { stat: afterHash, contentHash: secondHash, metadata, attempts: attempt };
    } catch (error) {
      if (error?.message === '素材路径不是文件') throw error;
      if (attempt < attempts && ['ENOENT', 'ESTALE', 'EBUSY', 'EPERM'].includes(String(error?.code || '').toUpperCase())) {
        lastChange = sourceChangedError();
        continue;
      }
      throw error;
    }
  }
  throw lastChange || sourceChangedError();
}

function walkFiles(root, maxFiles = 100000) {
  const result = [];
  if (!fs.existsSync(root)) return result;
  const queue = [root];
  while (queue.length && result.length < maxFiles) {
    const directory = queue.shift();
    let entries = [];
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch (_) { continue; }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) queue.push(fullPath);
      else if (entry.isFile()) result.push(fullPath);
      if (result.length >= maxFiles) break;
    }
  }
  return result;
}

const DERIVED_METADATA_FIELDS = Object.freeze([
  'thumbnailUrl', 'firstFrameUrl', 'lastFrameUrl', 'keyframeUrls', 'keyframeTimes',
  'contactSheetUrl', 'proxyUrl', 'waveformUrl', 'modelPreviewUrl', 'perceptualHash',
  'perceptualHashAlgorithm', 'perceptualHashes',
  'previewError',
]);

function previewStatePatchForJob(job) {
  const restoredResult = job?.status === 'succeeded' && job.result && typeof job.result === 'object'
    ? Object.fromEntries(DERIVED_METADATA_FIELDS
      .filter((field) => field !== 'previewError' && job.result[field] !== undefined)
      .map((field) => [field, job.result[field]]))
    : {};
  return {
    ...restoredResult,
    previewStatus: job?.status === 'succeeded' ? 'ready' : (job?.status || 'queued'),
    previewError: job?.errorMessage || null,
  };
}

class AssetIndexer {
  constructor(config, database, options = {}) {
    this.config = config;
    this.database = database;
    this.previewPipeline = options.previewPipeline || null;
    this.modelMetadataLimits = normalizeModelMetadataLimits(options.modelMetadataLimits);
    this.running = null;
    this.lastResult = null;
  }

  roots() {
    return [
      { name: 'input', path: this.config.INPUT_DIR, publicPrefix: '/files/input/' },
      { name: 'output', path: this.config.OUTPUT_DIR, publicPrefix: '/files/output/' },
    ];
  }

  status() {
    return { running: Boolean(this.running), lastResult: this.lastResult };
  }

  scan(options = {}) {
    if (this.running) return this.running;
    this.running = this.performScan(options).finally(() => { this.running = null; });
    return this.running;
  }

  async indexFile(filename, options = {}) {
    const absolute = path.resolve(filename);
    const rootName = String(options.rootName || 'linked');
    const rootPath = options.rootPath ? path.resolve(options.rootPath) : path.dirname(absolute);
    const relativePath = options.relativePath || (rootName === 'linked' ? absolute.replace(/\\/g, '/') : path.relative(rootPath, absolute));
    const publicRelativePath = rootName === 'linked' ? path.basename(absolute) : relativePath;
    const info = extensionInfo(absolute);
    const supportsDerivedPreview = ['image', 'video', 'audio', 'model3d'].includes(info.kind);
    const stableSource = await readStableAssetSource(absolute, info.kind, {
      attempts: options.sourceStabilityAttempts || this.config.ASSET_INDEX_STABILITY_ATTEMPTS || 2,
      metadataOptions: { modelMetadataLimits: this.modelMetadataLimits },
      buildDerived: !this.previewPipeline && supportsDerivedPreview
        ? ({ filename: source, kind, metadata, contentHash }) => createDerivedMedia(source, kind, metadata, this.config, contentHash)
        : null,
    });
    const { stat, contentHash } = stableSource;
    const metadata = stableSource.metadata;
    const storageMode = options.storageMode || (rootName === 'linked' ? 'linked' : 'managed');
    const assetRootIdentity = options.projectId ? `${options.projectId}:${rootName}` : rootName;
    const fallbackId = stableAssetId(assetRootIdentity, relativePath);
    const sourceLocator = stableSourceLocator(options.projectId, rootName, relativePath);
    const sourceUrl = options.sourceUrl || (rootName === 'linked'
      ? `/api/project-assets/${encodeURIComponent(fallbackId)}/media`
      : `${options.publicPrefix || `/files/${rootName}/`}${relativePath.split(path.sep).map(encodeURIComponent).join('/')}`);
    const currentAtSource = this.database.findAssetBySourceLocator?.(options.projectId, sourceLocator)
      || this.database.findAssetBySourceUrl?.(options.projectId, sourceUrl)
      || null;
    const historicalVersion = currentAtSource?.contentHash && currentAtSource.contentHash !== contentHash
      ? this.database.findAssetBySourceLocator?.(options.projectId, sourceLocator, {
        contentHash,
        includeReplaced: true,
      }) || null
      : null;
    const existingVersion = currentAtSource?.contentHash === contentHash
      ? currentAtSource
      : historicalVersion;
    // New source paths use a content-versioned identity from their first scan.
    // A legacy schema-15 row keeps its existing ID while its bytes are unchanged,
    // and replaceAssetAtSource can reactivate that row for an A -> B -> A cycle.
    const id = existingVersion?.id || versionedAssetId(assetRootIdentity, relativePath, contentHash);
    const availability = metadata.health === 'corrupt' ? 'corrupt' : 'available';
    const contentChangedAtSource = Boolean(currentAtSource?.contentHash && currentAtSource.contentHash !== contentHash);
    const existingMetadata = existingVersion?.metadata || {};
    const mergedMetadata = { ...existingMetadata, ...metadata };
    if (this.previewPipeline && supportsDerivedPreview) {
      if (metadata.health === 'corrupt') {
        mergedMetadata.previewStatus = 'failed';
        mergedMetadata.previewError = metadata.metadataError || '素材损坏，未加入预览队列';
      } else {
        mergedMetadata.previewStatus = existingVersion?.metadata?.previewStatus || 'queued';
        if (mergedMetadata.previewStatus !== 'failed') delete mergedMetadata.previewError;
      }
    }
    const assetInput = {
      id,
      projectId: options.projectId,
      contentHash,
      contentHashVerification: 'verified',
      perceptualHash: mergedMetadata.perceptualHash || existingVersion?.perceptualHash || null,
      perceptualHashAlgorithm: mergedMetadata.perceptualHashAlgorithm || existingVersion?.perceptualHashAlgorithm || null,
      kind: info.kind,
      mimeType: info.mimeType,
      filename: options.filename || path.basename(absolute),
      managedPath: absolute,
      sourceUrl: rootName === 'linked' ? `/api/project-assets/${encodeURIComponent(id)}/media` : sourceUrl,
      sourceLocator,
      storageMode,
      availability,
      metadata: {
        ...mergedMetadata,
        extension: info.extension,
        root: rootName,
        relativePath: String(publicRelativePath).replace(/\\/g, '/'),
      },
      provenance: {
        source: rootName === 'input' ? 'local-upload' : rootName === 'output' ? 'node-output' : 'linked-local-file',
        ...(existingVersion?.provenance || {}),
      },
      createdBy: options.creatorId || existingVersion?.createdBy || 'local-owner',
      createdAt: existingVersion?.createdAt || stat.birthtimeMs || stat.ctimeMs,
    };
    let asset;
    if (contentChangedAtSource && typeof this.database.replaceAssetAtSource === 'function') {
      const replacement = this.database.replaceAssetAtSource(currentAtSource.id, assetInput, {
        sourceType: 'source-version-replacement',
        derivedOperation: 'replaced-at-source',
        canvasId: options.canvasId,
        creatorId: options.creatorId,
        metadata: {
          storageMode,
          root: rootName,
          previousContentHash: currentAtSource.contentHash,
          contentHash,
        },
      });
      asset = replacement?.asset || this.database.getAsset?.(id);
    } else {
      asset = this.database.upsertAsset(assetInput);
    }
    if (!asset) throw new Error('素材索引写入失败');
    if (this.previewPipeline && supportsDerivedPreview && metadata.health !== 'corrupt') {
      const job = this.previewPipeline.enqueueAsset(asset);
      asset = this.database.patchAssetPreviewState(asset.id, contentHash, previewStatePatchForJob(job)) || asset;
    }
    if (options.recordLineage !== false && this.database.recordAssetLineageEvent) {
      this.database.recordAssetLineageEvent({
        assetId: asset.id,
        parentAssetId: options.parentAssetId,
        sourceType: options.sourceType || (rootName === 'input' ? 'upload' : rootName === 'output' ? 'output-scan' : 'linked-file'),
        sourceNodeId: options.sourceNodeId,
        sourceNodeType: options.sourceNodeType,
        runId: options.runId,
        nodeRunId: options.nodeRunId,
        attemptId: options.attemptId,
        canvasId: options.canvasId,
        creatorId: options.creatorId,
        promptSummary: options.promptSummary,
        derivedOperation: options.derivedOperation,
        metadata: { storageMode, root: rootName },
      });
    }
    return asset;
  }

  async recordRunOutputAssets(input = {}) {
    const run = this.database.getRun(input.runId);
    const nodeRun = this.database.getNodeRun(input.nodeRunId);
    if (!run || !nodeRun || nodeRun.runId !== run.id) throw new Error('输出记录不属于当前 Run');
    const attempt = input.attemptId ? this.database.getAttempt(input.attemptId) : null;
    if (input.attemptId && (!attempt || attempt.nodeRunId !== nodeRun.id)) throw new Error('输出 Attempt 不属于当前 NodeRun');
    const outputs = Array.isArray(input.outputs) ? input.outputs.slice(0, 100) : [];
    const normalized = [];
    for (const item of outputs) {
      if (!item || typeof item !== 'object') {
        normalized.push(item);
        continue;
      }
      const sourceUrl = String(item.sourceUrl || '').trim().slice(0, 16384);
      const clean = {
        kind: item.kind,
        sourceUrl,
        text: item.text,
        filename: item.filename,
        mimeType: item.mimeType,
        metadata: item.metadata && typeof item.metadata === 'object' ? item.metadata : {},
      };
      const resolved = resolveControlledOutputSource(sourceUrl, this.config);
      if (!resolved) {
        normalized.push({
          ...clean,
          storageMode: /^https?:\/\//i.test(sourceUrl) ? 'remote' : (sourceUrl ? 'linked' : 'embedded'),
          availability: sourceUrl ? 'unverified' : 'available',
        });
        continue;
      }
      if (!resolved.safe) {
        normalized.push({ ...clean, storageMode: 'linked', availability: 'unverified' });
        continue;
      }
      if (!resolved.exists) {
        normalized.push({
          ...clean,
          sourceUrl: resolved.sourceUrl,
          managedPath: resolved.absolute,
          storageMode: 'managed',
          availability: 'missing',
          metadata: {
            ...clean.metadata,
            health: 'missing',
            root: 'output',
            relativePath: resolved.relativePath.replace(/\\/g, '/'),
          },
        });
        continue;
      }
      try {
        const indexed = await this.indexFile(resolved.absolute, {
          projectId: run.projectId,
          rootName: 'output',
          rootPath: this.config.OUTPUT_DIR,
          publicPrefix: '/files/output/',
          relativePath: resolved.relativePath,
          storageMode: 'managed',
          creatorId: run.initiatorId,
          recordLineage: false,
        });
        normalized.push({
          ...clean,
          kind: indexed.kind,
          filename: indexed.filename,
          mimeType: indexed.mimeType,
          sourceUrl: indexed.sourceUrl,
          managedPath: indexed.managedPath,
          storageMode: indexed.storageMode,
          availability: indexed.availability,
          contentHash: indexed.contentHash,
          perceptualHash: indexed.perceptualHash,
          metadata: { ...clean.metadata, ...indexed.metadata },
        });
      } catch (_) {
        const missing = !fs.existsSync(resolved.absolute);
        normalized.push({
          ...clean,
          sourceUrl: resolved.sourceUrl,
          managedPath: resolved.absolute,
          storageMode: 'managed',
          availability: missing ? 'missing' : 'unverified',
          metadata: {
            ...clean.metadata,
            health: missing ? 'missing' : 'unverified',
            indexingStatus: 'failed',
            root: 'output',
            relativePath: resolved.relativePath.replace(/\\/g, '/'),
          },
        });
      }
    }
    return this.database.recordRunOutputAssets({ ...input, outputs: normalized });
  }

  indexLinkedFile(filename, options = {}) {
    return this.indexFile(filename, { ...options, rootName: 'linked', storageMode: 'linked' });
  }

  async performScan(options = {}) {
    const startedAt = Date.now();
    const roots = this.roots();
    const candidates = roots.flatMap((root) => walkFiles(root.path, Number(options.maxFiles) || 100000).map((filename) => ({ root, filename })));
    let indexed = 0;
    let failed = 0;
    let cursor = 0;
    const workers = Array.from({ length: Math.min(4, Math.max(1, Number(options.concurrency) || 2)) }, async () => {
      while (cursor < candidates.length) {
        const item = candidates[cursor++];
        const relativePath = path.relative(item.root.path, item.filename);
        try {
          await this.indexFile(item.filename, {
            projectId: options.projectId,
            rootName: item.root.name,
            rootPath: item.root.path,
            publicPrefix: item.root.publicPrefix,
            relativePath,
            storageMode: 'managed',
          });
          indexed += 1;
        } catch (_) {
          failed += 1;
        }
      }
    });
    await Promise.all(workers);
    const availability = this.database.refreshAssetAvailability?.(options.projectId) || { checked: 0, missing: 0, restored: 0 };
    this.lastResult = { total: candidates.length, indexed, failed, availability, startedAt, finishedAt: Date.now() };
    return this.lastResult;
  }
}

let backgroundIndexerSingleton = null;

function getBackgroundAssetIndexer(config, database, previewPipeline) {
  if (!backgroundIndexerSingleton) {
    backgroundIndexerSingleton = new AssetIndexer(config, database, { previewPipeline });
  }
  return backgroundIndexerSingleton;
}

module.exports = {
  AssetIndexer,
  getBackgroundAssetIndexer,
  EXTENSION_INFO,
  extensionInfo,
  resolveControlledOutputSource,
  stableAssetId,
  stableSourceLocator,
  versionedAssetId,
  hashFile,
  readMetadata,
  readStableAssetSource,
  sameSourceStat,
  parseExifBuffer,
  differenceHash,
  dctPerceptualHash,
  dct64FromGrayscale32,
  parseGltfDocument,
  parseObjMetadata,
  createDerivedMedia,
  runFfprobeKeyframes,
  selectBoundedTimestamps,
  writeAtomicTarget,
  previewStatePatchForJob,
  MAX_IMAGE_INPUT_PIXELS,
  PHASH_DCT64_ALGORITHM,
  DEFAULT_ASSET_PREVIEW_PIPELINE_VERSION,
  MODEL_METADATA_LIMITS,
  AssetModelMetadataError,
};
