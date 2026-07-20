const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');
const {
  MAX_JSON_ASSET_BYTES,
  buildCollaborationAllowedOrigins,
  detectBinaryKind,
  inspectJsonComplexity,
  normalizeRequestOrigin,
  originAllowed,
  validateUploadedAsset,
} = require('../backend/src/collaboration/gatewaySecurity');

test('gateway JSON and Origin guards reject abusive input while allowing same-origin requests', () => {
  let nested = {};
  for (let index = 0; index < 30; index += 1) nested = { child: nested };
  assert.throws(() => inspectJsonComplexity(nested), /层级过深/);
  assert.throws(() => inspectJsonComplexity(Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`k${index}`, index])), { maxKeys: 10 }), /字段数量过多/);
  const allowedOrigins = buildCollaborationAllowedOrigins({
    shareUrls: ['http://127.0.0.1:18767/collab', 'http://192.168.50.20:18767/collab'],
    configuredOrigins: ['https://proxy.example/app', 'javascript:alert(1)', 'not-a-url'],
    publicBaseUrl: 'https://collab.example/public/collab',
  });
  assert.deepEqual([...allowedOrigins].sort(), [
    'http://127.0.0.1:18767',
    'http://192.168.50.20:18767',
    'https://collab.example',
    'https://proxy.example',
  ]);
  assert.equal(originAllowed('http://127.0.0.1:18767', allowedOrigins), true);
  assert.equal(originAllowed('https://collab.example', allowedOrigins), true);
  assert.equal(originAllowed('https://proxy.example', allowedOrigins), true);
  assert.equal(originAllowed('https://evil.example', allowedOrigins), false);
  assert.equal(originAllowed('https://evil.example', ['https://collab.example']), false, 'request Host is never an origin authority');
  assert.equal(originAllowed('', allowedOrigins), true, 'native clients without Origin retain session-authenticated access');
  assert.equal(originAllowed('null', allowedOrigins), false);
  assert.equal(normalizeRequestOrigin('https://collab.example/path'), null);
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

test('collaboration upload rejects ZIP containers by bytes even when renamed', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-upload-archive-security-'));
  const archive = path.join(directory, 'model.zip');
  const renamed = path.join(directory, 'renamed.glb');
  const emptyZip = Buffer.from([0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  try {
    fs.writeFileSync(archive, emptyZip);
    fs.writeFileSync(renamed, emptyZip);
    assert.equal(detectBinaryKind(emptyZip), 'archive');
    await assert.rejects(
      validateUploadedAsset(archive, { extension: 'zip', kind: 'model3d' }),
      /不接受 ZIP\/归档容器/,
    );
    await assert.rejects(
      validateUploadedAsset(renamed, { extension: 'glb', kind: 'model3d' }),
      /不接受 ZIP\/归档容器/,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('collaboration JSON assets are size and complexity bounded before persistence', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-upload-json-security-'));
  const valid = path.join(directory, 'valid.json');
  const deep = path.join(directory, 'deep.json');
  const wide = path.join(directory, 'wide.json');
  const oversized = path.join(directory, 'oversized.json');
  try {
    fs.writeFileSync(valid, JSON.stringify({ title: 'safe', values: [1, 2, 3] }));
    let nested = { leaf: true };
    for (let index = 0; index < 30; index += 1) nested = { child: nested };
    fs.writeFileSync(deep, JSON.stringify(nested));
    fs.writeFileSync(wide, JSON.stringify(Object.fromEntries(
      Array.from({ length: 12_001 }, (_, index) => [`key-${index}`, index]),
    )));
    fs.writeFileSync(oversized, '{');
    fs.truncateSync(oversized, MAX_JSON_ASSET_BYTES + 1);

    assert.deepEqual(
      await validateUploadedAsset(valid, { extension: 'json', kind: 'text' }),
      { detectedKind: 'text' },
    );
    await assert.rejects(
      validateUploadedAsset(deep, { extension: 'json', kind: 'text' }),
      /层级过深/,
    );
    await assert.rejects(
      validateUploadedAsset(wide, { extension: 'json', kind: 'text' }),
      /字段数量过多/,
    );
    await assert.rejects(
      validateUploadedAsset(oversized, { extension: 'json', kind: 'text' }),
      /8 MiB/,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
