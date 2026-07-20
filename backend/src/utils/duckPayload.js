'use strict';

const sharp = require('sharp');

const WATERMARK_SKIP_W_RATIO = 0.40;
const WATERMARK_SKIP_H_RATIO = 0.08;
const DUCK_CHANNELS = 3;
const TRY_LSB_BITS = [2, 6, 8];
const MAX_DUCK_HEADER_BYTES = 512 * 1024 * 1024;
const MAX_DUCK_INPUT_PIXELS = 32 * 1024 * 1024;
const MAX_DUCK_RAW_BYTES = 96 * 1024 * 1024;
const MAX_DUCK_DIMENSION = 32_768;
const MAX_DUCK_FRAMES = 1;
const MAX_DUCK_CHANNELS = 4;
const DUCK_BIT_READER_YIELD_BYTES = 64 * 1024;

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif']);
const VIDEO_EXTS = new Set(['mp4', 'webm', 'mov', 'm4v', 'mkv', 'avi']);
const AUDIO_EXTS = new Set(['mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac']);
const TEXT_EXTS = new Set(['txt']);

function isPngBuffer(buf) {
  return Buffer.isBuffer(buf)
    && buf.length >= 8
    && buf[0] === 0x89
    && buf[1] === 0x50
    && buf[2] === 0x4e
    && buf[3] === 0x47
    && buf[4] === 0x0d
    && buf[5] === 0x0a
    && buf[6] === 0x1a
    && buf[7] === 0x0a;
}

class LsbBitReader {
  constructor(raw, width, height, channels, bitsPerChannel) {
    this.raw = raw;
    this.width = width;
    this.height = height;
    this.channels = channels;
    this.bitsPerChannel = bitsPerChannel;
    this.mask = (1 << bitsPerChannel) - 1;
    this.skipW = Math.floor(width * WATERMARK_SKIP_W_RATIO);
    this.skipH = Math.floor(height * WATERMARK_SKIP_H_RATIO);
    this.index = 0;
    this.current = 0;
    this.bitShift = -1;
  }

  isUsableIndex(idx) {
    const pixel = Math.floor(idx / this.channels);
    const y = Math.floor(pixel / this.width);
    const x = pixel - y * this.width;
    return !(this.skipW > 0 && this.skipH > 0 && y < this.skipH && x < this.skipW);
  }

  loadNextValue() {
    while (this.index < this.raw.length) {
      const idx = this.index;
      this.index += 1;
      if (!this.isUsableIndex(idx)) continue;
      this.current = this.raw[idx] & this.mask;
      this.bitShift = this.bitsPerChannel - 1;
      return true;
    }
    return false;
  }

  nextByte() {
    let byte = 0;
    let needed = 8;
    while (needed > 0) {
      if (this.bitShift < 0 && !this.loadNextValue()) {
        throw new Error('duck payload bits exhausted');
      }
      const available = this.bitShift + 1;
      const take = Math.min(needed, available);
      const shift = available - take;
      const segment = (this.current >> shift) & ((1 << take) - 1);
      byte = (byte << take) | segment;
      this.bitShift -= take;
      needed -= take;
    }
    return byte;
  }
}

function usableCapacityBits(width, height, channels, bitsPerChannel) {
  const skipW = Math.floor(width * WATERMARK_SKIP_W_RATIO);
  const skipH = Math.floor(height * WATERMARK_SKIP_H_RATIO);
  const excludedPixels = skipW > 0 && skipH > 0 ? skipW * skipH : 0;
  const usablePixels = Math.max(0, width * height - excludedPixels);
  return usablePixels * channels * bitsPerChannel;
}

function readUInt32FromBits(reader) {
  let n = 0;
  for (let i = 0; i < 4; i += 1) {
    n = n * 256 + reader.nextByte();
  }
  return n;
}

function yieldToEventLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function readBytesFromBits(reader, length) {
  const out = Buffer.allocUnsafe(length);
  for (let i = 0; i < length; i += 1) {
    out[i] = reader.nextByte();
    if ((i + 1) % DUCK_BIT_READER_YIELD_BYTES === 0 && i + 1 < length) {
      // A legal large Duck payload can require millions of bit reads. Keep the
      // protocol byte-for-byte compatible while allowing timers and requests
      // on the backend event loop to make progress between bounded CPU slices.
      await yieldToEventLoop();
    }
  }
  return out;
}

function normalizeExt(ext) {
  return String(ext || '')
    .trim()
    .toLowerCase()
    .replace(/^\./, '')
    .replace(/[^a-z0-9._+-]/g, '')
    .slice(0, 40);
}

function isKnownExt(ext) {
  const e = normalizeExt(ext);
  return IMAGE_EXTS.has(e) || VIDEO_EXTS.has(e) || AUDIO_EXTS.has(e) || TEXT_EXTS.has(e);
}

function kindFromExt(ext) {
  const e = normalizeExt(ext);
  if (IMAGE_EXTS.has(e)) return 'image';
  if (VIDEO_EXTS.has(e)) return 'video';
  if (AUDIO_EXTS.has(e)) return 'audio';
  if (TEXT_EXTS.has(e)) return 'text';
  return 'binary';
}

function mimeFromExt(ext) {
  const e = normalizeExt(ext);
  const map = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    gif: 'image/gif',
    bmp: 'image/bmp',
    avif: 'image/avif',
    mp4: 'video/mp4',
    webm: 'video/webm',
    mov: 'video/quicktime',
    m4v: 'video/x-m4v',
    mkv: 'video/x-matroska',
    avi: 'video/x-msvideo',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    ogg: 'audio/ogg',
    m4a: 'audio/mp4',
    flac: 'audio/flac',
    aac: 'audio/aac',
    txt: 'text/plain; charset=utf-8',
  };
  return map[e] || 'application/octet-stream';
}

function parseDuckHeader(header) {
  let idx = 0;
  if (!Buffer.isBuffer(header) || header.length < 1) {
    throw new Error('duck header too short');
  }

  const marker = header[idx];
  if (marker !== 0 && marker !== 1) {
    throw new Error('duck password marker invalid');
  }
  const hasPassword = marker === 1;
  idx += 1;

  if (hasPassword) {
    if (header.length < idx + 32 + 16) throw new Error('duck protected header too short');
    idx += 32 + 16;
  }

  if (header.length < idx + 1) throw new Error('duck ext length missing');
  const extLen = header[idx];
  idx += 1;
  if (extLen <= 0 || extLen > 40 || header.length < idx + extLen + 4) {
    throw new Error('duck ext length invalid');
  }

  const originalExt = normalizeExt(header.toString('utf-8', idx, idx + extLen));
  idx += extLen;
  if (!originalExt) throw new Error('duck ext missing');

  const dataLen = header.readUInt32BE(idx);
  idx += 4;
  if (dataLen < 0 || header.length - idx !== dataLen) {
    throw new Error('duck data length mismatch');
  }

  if (hasPassword) {
    return {
      isDuck: true,
      decoded: false,
      passwordProtected: true,
      originalExt,
    };
  }

  return {
    isDuck: true,
    decoded: true,
    passwordProtected: false,
    originalExt,
    // The decoded header already owns this allocation. Retain a view instead
    // of doubling the payload at the largest point in the decode.
    payload: header.subarray(idx),
  };
}

async function extractHeaderWithBits(raw, info, bitsPerChannel) {
  const channels = Math.min(info.channels || DUCK_CHANNELS, DUCK_CHANNELS);
  const capacityBits = usableCapacityBits(info.width, info.height, channels, bitsPerChannel);
  if (capacityBits < 40) throw new Error('duck image too small');

  const reader = new LsbBitReader(raw, info.width, info.height, channels, bitsPerChannel);
  const headerLen = readUInt32FromBits(reader);
  const totalBits = 32 + headerLen * 8;
  if (headerLen <= 0 || headerLen > MAX_DUCK_HEADER_BYTES || totalBits > capacityBits) {
    throw new Error('duck payload length invalid');
  }
  const header = await readBytesFromBits(reader, headerLen);
  return parseDuckHeader(header);
}

function trimTrailingZeroBytes(buf) {
  let end = buf.length;
  while (end > 0 && buf[end - 1] === 0) end -= 1;
  return buf.subarray(0, end);
}

async function binPngPayloadToBytes(payload) {
  await assertBoundedDuckPngMetadata(payload);
  const raw = await sharp(payload, { limitInputPixels: MAX_DUCK_INPUT_PIXELS, sequentialRead: true })
    .toColourspace('srgb')
    .removeAlpha()
    .raw()
    .toBuffer();
  if (raw.length > MAX_DUCK_RAW_BYTES) throw new Error('duck raw image exceeds memory limit');
  return trimTrailingZeroBytes(raw);
}

function outputExtFromOriginal(originalExt) {
  const e = normalizeExt(originalExt);
  if (!e.endsWith('.binpng')) return e;
  const base = normalizeExt(e.slice(0, -'.binpng'.length).replace(/\.$/, ''));
  return base || 'mp4';
}

async function tryDecodeDuckPayload(buf) {
  if (!isPngBuffer(buf)) return null;

  let raw;
  let info;
  try {
    await assertBoundedDuckPngMetadata(buf);
    const result = await sharp(buf, { limitInputPixels: MAX_DUCK_INPUT_PIXELS, sequentialRead: true })
      .toColourspace('srgb')
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    raw = result.data;
    info = result.info;
    if (raw.length > MAX_DUCK_RAW_BYTES) return null;
  } catch {
    return null;
  }

  for (const bits of TRY_LSB_BITS) {
    try {
      const parsed = await extractHeaderWithBits(raw, info, bits);
      if (parsed.passwordProtected) {
        return {
          isDuck: true,
          decoded: false,
          passwordProtected: true,
          originalExt: parsed.originalExt,
          lsbBits: bits,
        };
      }

      let outBuf = parsed.payload;
      let ext = outputExtFromOriginal(parsed.originalExt);
      if (normalizeExt(parsed.originalExt).endsWith('.binpng')) {
        outBuf = await binPngPayloadToBytes(parsed.payload);
        ext = isKnownExt(ext) ? ext : 'mp4';
      }
      if (!isKnownExt(ext)) ext = ext || 'bin';

      return {
        isDuck: true,
        decoded: true,
        passwordProtected: false,
        originalExt: parsed.originalExt,
        ext,
        kind: kindFromExt(ext),
        mime: mimeFromExt(ext),
        buffer: outBuf,
        lsbBits: bits,
      };
    } catch {
      // Try the next SS_tools compression bit width.
    }
  }

  return null;
}

async function assertBoundedDuckPngMetadata(buf) {
  const metadata = await sharp(buf, { limitInputPixels: MAX_DUCK_INPUT_PIXELS, sequentialRead: true }).metadata();
  const width = Number(metadata.width || 0);
  const height = Number(metadata.pageHeight || metadata.height || 0);
  const frames = Number(metadata.pages || 1);
  const channels = Number(metadata.channels || DUCK_CHANNELS);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)
    || !Number.isSafeInteger(frames) || !Number.isSafeInteger(channels)
    || width <= 0 || height <= 0 || frames <= 0 || channels <= 0
    || width > MAX_DUCK_DIMENSION || height > MAX_DUCK_DIMENSION
    || frames > MAX_DUCK_FRAMES || channels > MAX_DUCK_CHANNELS) {
    throw new Error('duck image metadata exceeds limits');
  }
  const pixels = BigInt(width) * BigInt(height) * BigInt(frames);
  const rawBytes = pixels * BigInt(Math.min(channels, DUCK_CHANNELS));
  if (pixels > BigInt(MAX_DUCK_INPUT_PIXELS) || rawBytes > BigInt(MAX_DUCK_RAW_BYTES)) {
    throw new Error('duck image dimensions exceed memory limit');
  }
  return { width, height, frames, channels };
}

module.exports = {
  MAX_DUCK_INPUT_PIXELS,
  MAX_DUCK_RAW_BYTES,
  assertBoundedDuckPngMetadata,
  tryDecodeDuckPayload,
  kindFromExt,
  mimeFromExt,
  isPngBuffer,
};
