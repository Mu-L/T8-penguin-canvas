const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');
const {
  MODEL_PREVIEW_LIMITS,
  renderModelPreview,
  parseModelGeometry,
  parseObjGeometry,
  parseStlGeometry,
  parseGlbGeometry,
} = require('../backend/src/services/modelPreviewRenderer');

function writeObj(filename, skewed = false) {
  const vertices = skewed
    ? [[-1.6, -0.7, -0.8], [1.3, -1.1, -0.4], [0.4, 1.7, -1.2], [-0.5, 0.2, 1.9]]
    : [[-1, -1, -1], [1, -1, -1], [0, 1, -1], [0, 0, 1]];
  const text = [
    '# tetrahedron fixture; no material or external files',
    ...vertices.map((vertex) => `v ${vertex.join(' ')}`),
    'f 1 2 3',
    'f 1 4 2',
    'f 2 4 3',
    'f 3 4 1',
  ].join('\n');
  fs.writeFileSync(filename, text);
}

function binaryStl(triangles) {
  const buffer = Buffer.alloc(84 + triangles.length * 50);
  buffer.write('T8 binary STL fixture', 0, 'ascii');
  buffer.writeUInt32LE(triangles.length, 80);
  triangles.forEach((triangle, triangleIndex) => {
    const offset = 84 + triangleIndex * 50;
    triangle.forEach((vertex, vertexIndex) => {
      const vertexOffset = offset + 12 + vertexIndex * 12;
      vertex.forEach((entry, coordinateIndex) => buffer.writeFloatLE(entry, vertexOffset + coordinateIndex * 4));
    });
  });
  return buffer;
}

function pad4(buffer, fill = 0) {
  const padded = Buffer.alloc(Math.ceil(buffer.length / 4) * 4, fill);
  buffer.copy(padded);
  return padded;
}

function createGlb({ externalUri } = {}) {
  if (externalUri) {
    const document = { asset: { version: '2.0' }, buffers: [{ byteLength: 12, uri: externalUri }] };
    const json = pad4(Buffer.from(JSON.stringify(document)), 0x20);
    const output = Buffer.alloc(12 + 8 + json.length);
    output.writeUInt32LE(0x46546C67, 0);
    output.writeUInt32LE(2, 4);
    output.writeUInt32LE(output.length, 8);
    output.writeUInt32LE(json.length, 12);
    output.writeUInt32LE(0x4E4F534A, 16);
    json.copy(output, 20);
    return output;
  }

  const positions = [
    [-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1],
    [-0.7, -0.7, 1.3], [0.7, -0.7, 1.3], [0.7, 0.7, 1.3], [-0.7, 0.7, 1.3],
  ];
  const indices = [
    0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7,
    0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5,
    2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7,
  ];
  const positionBuffer = Buffer.alloc(positions.length * 12);
  positions.flat().forEach((entry, index) => positionBuffer.writeFloatLE(entry, index * 4));
  const indexBuffer = Buffer.alloc(indices.length * 2);
  indices.forEach((entry, index) => indexBuffer.writeUInt16LE(entry, index * 2));
  const binary = pad4(Buffer.concat([positionBuffer, indexBuffer]));
  const document = {
    asset: { version: '2.0', generator: 'T8 renderer test' },
    buffers: [{ byteLength: positionBuffer.length + indexBuffer.length }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: positionBuffer.length },
      { buffer: 0, byteOffset: positionBuffer.length, byteLength: indexBuffer.length },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: positions.length, type: 'VEC3' },
      { bufferView: 1, componentType: 5123, count: indices.length, type: 'SCALAR' },
    ],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, mode: 4 }] }],
    nodes: [{ mesh: 0, translation: [0.2, 0.1, 0] }],
    scenes: [{ nodes: [0] }],
    scene: 0,
  };
  const json = pad4(Buffer.from(JSON.stringify(document)), 0x20);
  const output = Buffer.alloc(12 + 8 + json.length + 8 + binary.length);
  output.writeUInt32LE(0x46546C67, 0);
  output.writeUInt32LE(2, 4);
  output.writeUInt32LE(output.length, 8);
  output.writeUInt32LE(json.length, 12);
  output.writeUInt32LE(0x4E4F534A, 16);
  json.copy(output, 20);
  const binaryHeader = 20 + json.length;
  output.writeUInt32LE(binary.length, binaryHeader);
  output.writeUInt32LE(0x004E4942, binaryHeader + 4);
  binary.copy(output, binaryHeader + 8);
  return output;
}

function createCountOnlyGlb(positionCount) {
  const binary = pad4(Buffer.alloc(12));
  const document = {
    asset: { version: '2.0' },
    buffers: [{ byteLength: 12 }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 12 }],
    accessors: [{ bufferView: 0, componentType: 5126, count: positionCount, type: 'VEC3' }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, mode: 4 }] }],
  };
  const json = pad4(Buffer.from(JSON.stringify(document)), 0x20);
  const output = Buffer.alloc(12 + 8 + json.length + 8 + binary.length);
  output.writeUInt32LE(0x46546C67, 0);
  output.writeUInt32LE(2, 4);
  output.writeUInt32LE(output.length, 8);
  output.writeUInt32LE(json.length, 12);
  output.writeUInt32LE(0x4E4F534A, 16);
  json.copy(output, 20);
  const binaryHeader = 20 + json.length;
  output.writeUInt32LE(binary.length, binaryHeader);
  output.writeUInt32LE(0x004E4942, binaryHeader + 4);
  binary.copy(output, binaryHeader + 8);
  return output;
}

async function assertUsefulWebp(filename) {
  // Read from a buffer so libvips does not retain a Windows file handle in its cache.
  const encoded = fs.readFileSync(filename);
  const metadata = await sharp(encoded).metadata();
  assert.equal(metadata.format, 'webp');
  assert.equal(metadata.width, 512);
  assert.equal(metadata.height, 512);
  const stats = await sharp(encoded).stats();
  assert.equal(stats.channels.some((channel) => channel.stdev > 12), true, 'preview should contain visible geometry and shading');
  const raw = await sharp(encoded).resize(64, 64).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const colors = new Set();
  for (let offset = 0; offset < raw.data.length; offset += raw.info.channels) {
    colors.add(`${raw.data[offset] >> 3}:${raw.data[offset + 1] >> 3}:${raw.data[offset + 2] >> 3}`);
  }
  assert.equal(colors.size > 48, true, `preview should not be a flat placeholder; got ${colors.size} quantized colors`);
}

test('OBJ geometry creates deterministic 512px WebP previews whose pixels reflect different meshes', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-model-preview-obj-'));
  try {
    const sourceA = path.join(directory, 'regular.obj');
    const sourceB = path.join(directory, 'skewed.obj');
    const targetA = path.join(directory, 'regular.webp');
    const targetB = path.join(directory, 'skewed.webp');
    writeObj(sourceA, false);
    writeObj(sourceB, true);
    const resultA = await renderModelPreview({ sourcePath: sourceA, targetPath: targetA });
    const resultB = await renderModelPreview({ sourcePath: sourceB, targetPath: targetB, width: 512, height: 512 });
    assert.deepEqual({ width: resultA.width, height: resultA.height, vertexCount: resultA.vertexCount, triangleCount: resultA.triangleCount }, { width: 512, height: 512, vertexCount: 4, triangleCount: 4 });
    assert.equal(resultA.targetPath, path.resolve(targetA));
    assert.equal(resultA.mimeType, 'image/webp');
    assert.equal(resultA.renderedTriangleCount, 4);
    assert.notEqual(resultA.sha256, resultB.sha256, 'same-format meshes with equal counts but different geometry must render differently');
    assert.equal(resultA.sha256, crypto.createHash('sha256').update(fs.readFileSync(targetA)).digest('hex'));
    await assertUsefulWebp(targetA);
    await assertUsefulWebp(targetB);
    const replaced = await renderModelPreview({ sourcePath: sourceB, targetPath: targetA });
    assert.equal(replaced.sha256, resultB.sha256, 'atomic rename should safely replace an existing Windows preview target');
    await assertUsefulWebp(targetA);
    assert.deepEqual(fs.readdirSync(directory).filter((name) => name.includes('.tmp-')), []);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 });
  }
});

test('binary STL and embedded GLB are parsed from real triangle data and rendered as WebP', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-model-preview-formats-'));
  try {
    const a = [-1, -1, -1]; const b = [1, -1, -1]; const c = [0, 1, -1]; const d = [0, 0, 1.2];
    const stlSource = path.join(directory, 'tetra.stl');
    const glbSource = path.join(directory, 'frustum.glb');
    const stlTarget = path.join(directory, 'tetra.webp');
    const glbTarget = path.join(directory, 'frustum.webp');
    fs.writeFileSync(stlSource, binaryStl([[a, b, c], [a, d, b], [b, d, c], [c, d, a]]));
    fs.writeFileSync(glbSource, createGlb());
    const stl = await renderModelPreview({ sourcePath: stlSource, targetPath: stlTarget });
    const glb = await renderModelPreview({ sourcePath: glbSource, targetPath: glbTarget });
    assert.deepEqual({ format: stl.format, vertexCount: stl.vertexCount, triangleCount: stl.triangleCount }, { format: 'stl', vertexCount: 12, triangleCount: 4 });
    assert.deepEqual({ format: glb.format, vertexCount: glb.vertexCount, triangleCount: glb.triangleCount }, { format: 'glb', vertexCount: 8, triangleCount: 12 });
    assert.notEqual(stl.sha256, glb.sha256);
    await assertUsefulWebp(stlTarget);
    await assertUsefulWebp(glbTarget);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 });
  }
});

test('corrupt models and external GLB references fail safely without targets or temporary files', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-model-preview-invalid-'));
  try {
    const broken = path.join(directory, 'broken.glb');
    const external = path.join(directory, 'external.glb');
    const oversizedStl = path.join(directory, 'oversized.stl');
    const brokenTarget = path.join(directory, 'broken.webp');
    const externalTarget = path.join(directory, 'external.webp');
    fs.writeFileSync(broken, Buffer.from('not a glb'));
    fs.writeFileSync(path.join(directory, 'outside.bin'), Buffer.alloc(12, 7));
    fs.writeFileSync(external, createGlb({ externalUri: '../outside.bin' }));
    const oversizedHeader = Buffer.alloc(84);
    oversizedHeader.write('T8 hostile binary STL count', 0, 'ascii');
    oversizedHeader.writeUInt32LE(Math.floor(500_000 / 3) + 1, 80);
    fs.writeFileSync(oversizedStl, oversizedHeader);
    await assert.rejects(
      renderModelPreview({ sourcePath: broken, targetPath: brokenTarget }),
      (error) => error?.code === 'INVALID_GLB' && !String(error.message).includes(directory),
    );
    assert.throws(
      () => parseModelGeometry(external),
      (error) => error?.code === 'EXTERNAL_REFERENCE_FORBIDDEN' && !String(error.message).includes('outside.bin'),
    );
    assert.throws(
      () => parseModelGeometry(oversizedStl),
      (error) => error?.code === 'MODEL_TOO_COMPLEX',
      'the binary STL face count must be rejected from the header before allocating vertex arrays',
    );
    assert.equal(fs.existsSync(brokenTarget), false);
    assert.equal(fs.existsSync(externalTarget), false);
    assert.deepEqual(fs.readdirSync(directory).filter((name) => name.includes('.tmp-')), []);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 });
  }
});

test('renderer enforces its hard memory budget from stat and declared counts before large allocations', () => {
  assert.equal(MODEL_PREVIEW_LIMITS.maxSourceBytes, 64 * 1024 * 1024);
  assert.equal(MODEL_PREVIEW_LIMITS.maxVertices <= 100_000, true);
  assert.equal(MODEL_PREVIEW_LIMITS.maxTriangles <= 200_000, true);
  assert.equal(MODEL_PREVIEW_LIMITS.maxLines, 400_000);
  assert.equal(
    MODEL_PREVIEW_LIMITS.maxVertices * 3 * Float64Array.BYTES_PER_ELEMENT
      + MODEL_PREVIEW_LIMITS.maxTriangles * 3 * Uint32Array.BYTES_PER_ELEMENT
      <= MODEL_PREVIEW_LIMITS.maxGeometryBytes,
    true,
  );

  const nearLimitStl = Buffer.alloc(84);
  nearLimitStl.write('T8 bounded STL header', 0, 'ascii');
  nearLimitStl.writeUInt32LE(Math.floor(MODEL_PREVIEW_LIMITS.maxVertices / 3), 80);
  assert.throws(
    () => parseStlGeometry(nearLimitStl),
    (error) => error?.code === 'INVALID_STL',
    'a near-limit declared STL must detect truncation before allocating its typed arrays',
  );
  const overLimitStl = Buffer.from(nearLimitStl);
  overLimitStl.writeUInt32LE(Math.floor(MODEL_PREVIEW_LIMITS.maxVertices / 3) + 1, 80);
  assert.throws(() => parseStlGeometry(overLimitStl), (error) => error?.code === 'MODEL_TOO_COMPLEX');

  assert.throws(
    () => parseGlbGeometry(createCountOnlyGlb(MODEL_PREVIEW_LIMITS.maxVertices)),
    (error) => error?.code === 'INVALID_GLB',
    'a near-limit accessor with a tiny buffer must be rejected on bounds before scene allocation',
  );
  assert.throws(
    () => parseGlbGeometry(createCountOnlyGlb(MODEL_PREVIEW_LIMITS.maxVertices + 1)),
    (error) => error?.code === 'MODEL_TOO_COMPLEX',
  );
  assert.throws(
    () => parseObjGeometry(Buffer.alloc(MODEL_PREVIEW_LIMITS.maxLines + 1, 0x0A)),
    (error) => error?.code === 'MODEL_TOO_COMPLEX' && /行数/.test(error.message),
    'hundreds of thousands of empty lines must stop at the line-count gate before geometry allocation',
  );

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-model-preview-stat-limit-'));
  const source = path.join(directory, 'tiny.obj');
  fs.writeFileSync(source, 'v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n');
  const originalStatSync = fs.statSync;
  const originalReadFileSync = fs.readFileSync;
  let sourceReads = 0;
  try {
    fs.statSync = function boundedStat(candidate, ...args) {
      if (path.resolve(String(candidate)) === path.resolve(source)) {
        return { isFile: () => true, size: MODEL_PREVIEW_LIMITS.maxSourceBytes + 1 };
      }
      return originalStatSync.call(this, candidate, ...args);
    };
    fs.readFileSync = function guardedRead(candidate, ...args) {
      if (path.resolve(String(candidate)) === path.resolve(source)) sourceReads += 1;
      return originalReadFileSync.call(this, candidate, ...args);
    };
    assert.throws(() => parseModelGeometry(source), (error) => error?.code === 'SOURCE_TOO_LARGE');
    assert.equal(sourceReads, 0, 'source stat gate must run before fs.readFileSync');
  } finally {
    fs.statSync = originalStatSync;
    fs.readFileSync = originalReadFileSync;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
