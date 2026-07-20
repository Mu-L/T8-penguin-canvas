const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');
const {
  detectBinaryKind,
  inspectJsonComplexity,
  originAllowed,
  validateUploadedAsset,
} = require('../backend/src/collaboration/gatewaySecurity');

test('gateway JSON and Origin guards reject abusive input while allowing same-origin requests', () => {
  let nested = {};
  for (let index = 0; index < 30; index += 1) nested = { child: nested };
  assert.throws(() => inspectJsonComplexity(nested), /层级过深/);
  assert.throws(() => inspectJsonComplexity(Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`k${index}`, index])), { maxKeys: 10 }), /字段数量过多/);
  assert.equal(originAllowed('http://127.0.0.1:18767', '127.0.0.1:18767', []), true);
  assert.equal(originAllowed('https://collab.example', '127.0.0.1:18767', ['https://collab.example']), true);
  assert.equal(originAllowed('https://evil.example', '127.0.0.1:18767', ['https://collab.example']), false);
});

test('upload magic validation accepts decoded images and rejects extension spoofing', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-upload-security-'));
  const image = path.join(directory, 'valid.png');
  const spoofed = path.join(directory, 'spoofed.png');
  try {
    await sharp({ create: { width: 8, height: 8, channels: 4, background: '#33aa77' } }).png().toFile(image);
    fs.writeFileSync(spoofed, 'this is not a png');
    assert.equal(detectBinaryKind(fs.readFileSync(image).subarray(0, 32)), 'image');
    assert.equal((await validateUploadedAsset(image, { extension: 'png', kind: 'image' })).width, 8);
    await assert.rejects(validateUploadedAsset(spoofed, { extension: 'png', kind: 'image' }), /扩展名不一致/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
