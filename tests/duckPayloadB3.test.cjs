'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const sharp = require('sharp');

const {
  MAX_DUCK_INPUT_PIXELS,
  assertBoundedDuckPngMetadata,
  tryDecodeDuckPayload,
} = require('../backend/src/utils/duckPayload');

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const value of buffer) {
    crc ^= value;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function rewritePngDimensions(buffer, width, height) {
  const result = Buffer.from(buffer);
  assert.equal(result.subarray(12, 16).toString('ascii'), 'IHDR');
  result.writeUInt32BE(width, 16);
  result.writeUInt32BE(height, 20);
  result.writeUInt32BE(crc32(result.subarray(12, 29)), 29);
  return result;
}

async function createDuckPng(payload, originalExt = 'mp4', bitsPerChannel = 2) {
  const ext = Buffer.from(originalExt, 'utf8');
  const dataLength = Buffer.allocUnsafe(4);
  dataLength.writeUInt32BE(payload.length);
  const header = Buffer.concat([
    Buffer.from([0, ext.length]),
    ext,
    dataLength,
    payload,
  ]);
  const headerLength = Buffer.allocUnsafe(4);
  headerLength.writeUInt32BE(header.length);
  const encoded = Buffer.concat([headerLength, header]);
  const requiredBits = encoded.length * 8;
  const width = 256;
  let height = 1;
  while (true) {
    const skipW = Math.floor(width * 0.40);
    const skipH = Math.floor(height * 0.08);
    const usablePixels = width * height - (skipW > 0 && skipH > 0 ? skipW * skipH : 0);
    if (usablePixels * 3 * bitsPerChannel >= requiredBits) break;
    height += 1;
  }

  const raw = Buffer.alloc(width * height * 3, 0x40);
  const mask = (1 << bitsPerChannel) - 1;
  const skipW = Math.floor(width * 0.40);
  const skipH = Math.floor(height * 0.08);
  let bitOffset = 0;
  for (let index = 0; index < raw.length && bitOffset < requiredBits; index += 1) {
    const pixel = Math.floor(index / 3);
    const y = Math.floor(pixel / width);
    const x = pixel - y * width;
    if (skipW > 0 && skipH > 0 && y < skipH && x < skipW) continue;
    let value = 0;
    for (let bit = 0; bit < bitsPerChannel; bit += 1) {
      value <<= 1;
      if (bitOffset < requiredBits) {
        value |= (encoded[Math.floor(bitOffset / 8)] >> (7 - (bitOffset % 8))) & 1;
        bitOffset += 1;
      }
    }
    raw[index] = (raw[index] & ~mask) | value;
  }
  assert.equal(bitOffset, requiredBits);
  return sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

test('Duck decoder validates PNG metadata and pixel budget before allocating raw pixels', async () => {
  const validPng = await sharp({
    create: { width: 2, height: 2, channels: 4, background: { r: 12, g: 34, b: 56, alpha: 1 } },
  }).png().toBuffer();
  const metadata = await assertBoundedDuckPngMetadata(validPng);
  assert.deepEqual({ width: metadata.width, height: metadata.height, frames: metadata.frames }, {
    width: 2,
    height: 2,
    frames: 1,
  });
  assert.equal(await tryDecodeDuckPayload(validPng), null, 'ordinary PNG is not a Duck payload');

  const oversizedHeader = rewritePngDimensions(validPng, 100_000, 100_000);
  const startedAt = Date.now();
  await assert.rejects(assertBoundedDuckPngMetadata(oversizedHeader));
  assert.equal(await tryDecodeDuckPayload(oversizedHeader), null);
  assert.ok(Date.now() - startedAt < 2_000, 'oversized dimensions must fail before a giant raw allocation');
  assert.ok(100_000 * 100_000 > MAX_DUCK_INPUT_PIXELS);

  const source = fs.readFileSync(path.join(__dirname, '..', 'backend', 'src', 'utils', 'duckPayload.js'), 'utf8');
  assert.doesNotMatch(source, /limitInputPixels:\s*false/);
  assert.match(source, /metadata\(\)[\s\S]*?MAX_DUCK_RAW_BYTES/);
});

test('Duck decoder keeps a zero-copy payload view and yields during large bit extraction', async () => {
  const payload = Buffer.alloc(96 * 1024);
  for (let index = 0; index < payload.length; index += 1) payload[index] = index % 251;
  const duckPng = await createDuckPng(payload);

  const nativeSetImmediate = global.setImmediate;
  let yieldCount = 0;
  global.setImmediate = function trackedSetImmediate(...args) {
    yieldCount += 1;
    return nativeSetImmediate(...args);
  };
  let decoded;
  try {
    decoded = await tryDecodeDuckPayload(duckPng);
  } finally {
    global.setImmediate = nativeSetImmediate;
  }

  assert.equal(decoded?.decoded, true);
  assert.equal(decoded?.ext, 'mp4');
  assert.deepEqual(decoded?.buffer, payload);
  assert.ok(decoded.buffer.byteOffset > 0, 'payload must remain a view into its decoded header allocation');
  assert.ok(yieldCount > 0, 'large synchronous bit extraction must yield to the event loop');

  const source = fs.readFileSync(path.join(__dirname, '..', 'backend', 'src', 'utils', 'duckPayload.js'), 'utf8');
  assert.doesNotMatch(source, /payload:\s*Buffer\.from\(header\.subarray/);
  assert.doesNotMatch(source, /return Buffer\.from\(buf\.subarray/);
  assert.match(source, /setImmediate/);
});

test('Duck decoder preserves legal 2-bit, 6-bit, and 8-bit payload variants', async () => {
  for (const bitsPerChannel of [2, 6, 8]) {
    const payload = Buffer.alloc(4 * 1024);
    for (let index = 0; index < payload.length; index += 1) {
      payload[index] = (index * 17 + bitsPerChannel) % 251;
    }
    const duckPng = await createDuckPng(payload, 'mp3', bitsPerChannel);
    const decoded = await tryDecodeDuckPayload(duckPng);
    assert.equal(decoded?.decoded, true, `${bitsPerChannel}-bit Duck payload must decode`);
    assert.equal(decoded?.lsbBits, bitsPerChannel);
    assert.equal(decoded?.ext, 'mp3');
    assert.deepEqual(decoded?.buffer, payload);
  }
});
