const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');

// A model preview runs in the same process as the desktop backend. Keep its
// worst-case resident set bounded: one 64 MiB source buffer, at most 4.8 MiB
// of typed geometry, a bounded set of render faces, and libvips' image work.
const MODEL_PREVIEW_LIMITS = Object.freeze({
  maxSourceBytes: 64 * 1024 * 1024,
  maxGlbJsonBytes: 8 * 1024 * 1024,
  maxGeometryBytes: 16 * 1024 * 1024,
  maxVertices: 100_000,
  maxTriangles: 200_000,
  maxRenderTriangles: 12_000,
  maxLineBytes: 1_000_000,
  maxLines: 400_000,
  maxFaceVertices: 4096,
  maxStructuralEntries: 200_000,
  maxNodeDepth: 128,
  maxNodeVisits: 200_000,
});

const {
  maxSourceBytes: MAX_SOURCE_BYTES,
  maxGlbJsonBytes: MAX_GLB_JSON_BYTES,
  maxGeometryBytes: MAX_GEOMETRY_BYTES,
  maxVertices: MAX_VERTICES,
  maxTriangles: MAX_TRIANGLES,
  maxRenderTriangles: MAX_RENDER_TRIANGLES,
  maxLineBytes: MAX_LINE_BYTES,
  maxLines: MAX_LINES,
  maxFaceVertices: MAX_FACE_VERTICES,
  maxStructuralEntries: MAX_STRUCTURAL_ENTRIES,
  maxNodeDepth: MAX_NODE_DEPTH,
  maxNodeVisits: MAX_NODE_VISITS,
} = MODEL_PREVIEW_LIMITS;

class ModelPreviewError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ModelPreviewError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new ModelPreviewError(code, message);
}

function finiteNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) fail('INVALID_GEOMETRY', `${label} 不是有限数值`);
  return number;
}

function assertGeometryBudget(vertexCount, triangleCount, label = '模型') {
  if (!Number.isSafeInteger(vertexCount) || vertexCount < 3 || vertexCount > MAX_VERTICES) {
    fail(vertexCount < 3 ? 'EMPTY_GEOMETRY' : 'MODEL_TOO_COMPLEX', `${label}顶点数量无效或超过 ${MAX_VERTICES}`);
  }
  if (!Number.isSafeInteger(triangleCount) || triangleCount < 1 || triangleCount > MAX_TRIANGLES) {
    fail(triangleCount < 1 ? 'EMPTY_GEOMETRY' : 'MODEL_TOO_COMPLEX', `${label}三角面数量无效或超过 ${MAX_TRIANGLES}`);
  }
  const bytes = vertexCount * 3 * Float64Array.BYTES_PER_ELEMENT
    + triangleCount * 3 * Uint32Array.BYTES_PER_ELEMENT;
  if (!Number.isSafeInteger(bytes) || bytes > MAX_GEOMETRY_BYTES) {
    fail('MODEL_TOO_COMPLEX', `${label}几何内存预算超过 ${MAX_GEOMETRY_BYTES} bytes`);
  }
  return bytes;
}

function allocateGeometry(format, vertexCount, triangleCount, label) {
  assertGeometryBudget(vertexCount, triangleCount, label);
  try {
    return {
      format,
      positions: new Float64Array(vertexCount * 3),
      indices: new Uint32Array(triangleCount * 3),
      vertexCount,
      triangleCount,
    };
  } catch (_) {
    fail('MODEL_MEMORY_LIMIT', '3D 模型预览内存分配失败');
  }
}

function ensureGeometryBounds(geometry) {
  const { positions, indices, vertexCount, triangleCount } = geometry || {};
  if (!(positions instanceof Float64Array) || positions.length < vertexCount * 3) fail('INVALID_GEOMETRY', '模型顶点缓冲区无效');
  if (!(indices instanceof Uint32Array) || indices.length < triangleCount * 3) fail('INVALID_GEOMETRY', '模型三角面缓冲区无效');
  assertGeometryBudget(vertexCount, triangleCount);

  for (let index = 0; index < vertexCount * 3; index += 1) {
    if (!Number.isFinite(positions[index])) fail('INVALID_GEOMETRY', `顶点 ${Math.floor(index / 3)} 不是有限数值`);
  }

  // Compact non-degenerate faces in place. This avoids the former full-size
  // usableTriangles copy while retaining honest triangle counts.
  let usableTriangles = 0;
  for (let triangleIndex = 0; triangleIndex < triangleCount; triangleIndex += 1) {
    const indexOffset = triangleIndex * 3;
    const ia = indices[indexOffset];
    const ib = indices[indexOffset + 1];
    const ic = indices[indexOffset + 2];
    if (ia >= vertexCount || ib >= vertexCount || ic >= vertexCount) {
      fail('INVALID_GEOMETRY', `三角面 ${triangleIndex} 引用了不存在的顶点`);
    }
    const a = ia * 3; const b = ib * 3; const c = ic * 3;
    const abx = positions[b] - positions[a];
    const aby = positions[b + 1] - positions[a + 1];
    const abz = positions[b + 2] - positions[a + 2];
    const acx = positions[c] - positions[a];
    const acy = positions[c + 1] - positions[a + 1];
    const acz = positions[c + 2] - positions[a + 2];
    const crossX = aby * acz - abz * acy;
    const crossY = abz * acx - abx * acz;
    const crossZ = abx * acy - aby * acx;
    if (crossX ** 2 + crossY ** 2 + crossZ ** 2 <= 1e-20) continue;
    const writeOffset = usableTriangles * 3;
    if (writeOffset !== indexOffset) {
      indices[writeOffset] = ia;
      indices[writeOffset + 1] = ib;
      indices[writeOffset + 2] = ic;
    }
    usableTriangles += 1;
  }
  if (!usableTriangles) fail('EMPTY_GEOMETRY', '模型三角面全部退化，无法渲染');
  return {
    ...geometry,
    indices: indices.subarray(0, usableTriangles * 3),
    triangleCount: usableTriangles,
  };
}

function forEachUtf8Line(buffer, label, visitor) {
  let start = 0;
  let lineNumber = 0;
  for (let cursor = 0; cursor <= buffer.length; cursor += 1) {
    if (cursor !== buffer.length && buffer[cursor] !== 0x0A) continue;
    if (cursor === buffer.length && start === buffer.length) break;
    lineNumber += 1;
    if (lineNumber > MAX_LINES) fail('MODEL_TOO_COMPLEX', `${label}行数超过 ${MAX_LINES}`);
    let end = cursor;
    if (end > start && buffer[end - 1] === 0x0D) end -= 1;
    if (end - start > MAX_LINE_BYTES) fail('MODEL_TOO_COMPLEX', `${label}第 ${lineNumber} 行超过 ${MAX_LINE_BYTES} bytes`);
    visitor(buffer.toString('utf8', start, end), lineNumber);
    start = cursor + 1;
  }
}

function parseObjIndex(token, vertexCount, lineNumber) {
  const raw = Number.parseInt(String(token).split('/')[0], 10);
  if (!Number.isSafeInteger(raw) || raw === 0) fail('INVALID_OBJ', `OBJ 第 ${lineNumber} 行顶点索引无效`);
  const index = raw < 0 ? vertexCount + raw : raw - 1;
  if (index < 0 || index >= vertexCount) fail('INVALID_OBJ', `OBJ 第 ${lineNumber} 行顶点索引越界`);
  return index;
}

function inspectObjGeometry(buffer) {
  let vertexCount = 0;
  let triangleCount = 0;
  forEachUtf8Line(buffer, 'OBJ ', (rawLine, lineNumber) => {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) return;
    const parts = line.split(/\s+/);
    if (parts[0] === 'v') {
      if (parts.length < 4) fail('INVALID_OBJ', `OBJ 第 ${lineNumber} 行顶点不完整`);
      finiteNumber(parts[1], `OBJ 第 ${lineNumber} 行 x`);
      finiteNumber(parts[2], `OBJ 第 ${lineNumber} 行 y`);
      finiteNumber(parts[3], `OBJ 第 ${lineNumber} 行 z`);
      vertexCount += 1;
      if (vertexCount > MAX_VERTICES) fail('MODEL_TOO_COMPLEX', `OBJ 顶点超过 ${MAX_VERTICES}`);
      return;
    }
    if (parts[0] !== 'f') return;
    const faceTokens = parts.slice(1).filter(Boolean);
    if (faceTokens.length < 3) fail('INVALID_OBJ', `OBJ 第 ${lineNumber} 行面不完整`);
    if (faceTokens.length > MAX_FACE_VERTICES) fail('MODEL_TOO_COMPLEX', `OBJ 第 ${lineNumber} 行面顶点过多`);
    faceTokens.forEach((token) => parseObjIndex(token, vertexCount, lineNumber));
    triangleCount += faceTokens.length - 2;
    if (triangleCount > MAX_TRIANGLES) fail('MODEL_TOO_COMPLEX', `OBJ 三角面超过 ${MAX_TRIANGLES}`);
  });
  assertGeometryBudget(vertexCount, triangleCount, 'OBJ ');
  return { vertexCount, triangleCount };
}

function parseObjGeometry(buffer) {
  if (!Buffer.isBuffer(buffer)) fail('INVALID_OBJ', 'OBJ 输入不是二进制缓冲区');
  if (buffer.length > MAX_SOURCE_BYTES) fail('SOURCE_TOO_LARGE', `OBJ 超过 ${MAX_SOURCE_BYTES} bytes`);
  if (buffer.includes(0)) fail('INVALID_OBJ', 'OBJ 包含无效二进制数据');
  const inspected = inspectObjGeometry(buffer);
  const geometry = allocateGeometry('obj', inspected.vertexCount, inspected.triangleCount, 'OBJ ');
  let vertexWrite = 0;
  let triangleWrite = 0;
  forEachUtf8Line(buffer, 'OBJ ', (rawLine, lineNumber) => {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) return;
    const parts = line.split(/\s+/);
    if (parts[0] === 'v') {
      const offset = vertexWrite * 3;
      geometry.positions[offset] = finiteNumber(parts[1], `OBJ 第 ${lineNumber} 行 x`);
      geometry.positions[offset + 1] = finiteNumber(parts[2], `OBJ 第 ${lineNumber} 行 y`);
      geometry.positions[offset + 2] = finiteNumber(parts[3], `OBJ 第 ${lineNumber} 行 z`);
      vertexWrite += 1;
      return;
    }
    if (parts[0] !== 'f') return;
    const faceTokens = parts.slice(1).filter(Boolean);
    const first = parseObjIndex(faceTokens[0], vertexWrite, lineNumber);
    let previous = parseObjIndex(faceTokens[1], vertexWrite, lineNumber);
    for (let tokenIndex = 2; tokenIndex < faceTokens.length; tokenIndex += 1) {
      const current = parseObjIndex(faceTokens[tokenIndex], vertexWrite, lineNumber);
      const offset = triangleWrite * 3;
      geometry.indices[offset] = first;
      geometry.indices[offset + 1] = previous;
      geometry.indices[offset + 2] = current;
      previous = current;
      triangleWrite += 1;
    }
  });
  return ensureGeometryBounds(geometry);
}

function maximumBinaryStlTriangles() {
  return Math.min(MAX_TRIANGLES, Math.floor(MAX_VERTICES / 3));
}

function parseBinaryStl(buffer, triangleCount) {
  const maximum = maximumBinaryStlTriangles();
  // The 84-byte header is sufficient to reject a hostile count before any
  // typed geometry allocation.
  if (!Number.isSafeInteger(triangleCount) || triangleCount < 1 || triangleCount > maximum) {
    fail('MODEL_TOO_COMPLEX', 'STL 三角面数量无效或超限');
  }
  const expectedLength = 84 + triangleCount * 50;
  if (expectedLength > buffer.length) fail('INVALID_STL', '二进制 STL 数据被截断');
  const geometry = allocateGeometry('stl', triangleCount * 3, triangleCount, 'STL ');
  for (let triangleIndex = 0; triangleIndex < triangleCount; triangleIndex += 1) {
    const recordOffset = 84 + triangleIndex * 50;
    for (let vertexIndex = 0; vertexIndex < 3; vertexIndex += 1) {
      const sourceOffset = recordOffset + 12 + vertexIndex * 12;
      const vertex = triangleIndex * 3 + vertexIndex;
      const targetOffset = vertex * 3;
      geometry.positions[targetOffset] = buffer.readFloatLE(sourceOffset);
      geometry.positions[targetOffset + 1] = buffer.readFloatLE(sourceOffset + 4);
      geometry.positions[targetOffset + 2] = buffer.readFloatLE(sourceOffset + 8);
      geometry.indices[vertex] = vertex;
    }
  }
  return ensureGeometryBounds(geometry);
}

function inspectAsciiStl(buffer) {
  let vertexCount = 0;
  forEachUtf8Line(buffer, 'ASCII STL ', (rawLine) => {
    const parts = rawLine.trim().split(/\s+/);
    if (String(parts[0] || '').toLowerCase() !== 'vertex') return;
    if (parts.length < 4) fail('INVALID_STL', 'ASCII STL 顶点不完整');
    finiteNumber(parts[1], 'STL vertex.x');
    finiteNumber(parts[2], 'STL vertex.y');
    finiteNumber(parts[3], 'STL vertex.z');
    vertexCount += 1;
    if (vertexCount > MAX_VERTICES) fail('MODEL_TOO_COMPLEX', `STL 顶点超过 ${MAX_VERTICES}`);
  });
  if (!vertexCount || vertexCount % 3 !== 0) fail('INVALID_STL', 'ASCII STL 没有完整三角面');
  assertGeometryBudget(vertexCount, vertexCount / 3, 'STL ');
  return vertexCount;
}

function parseAsciiStl(buffer) {
  if (buffer.includes(0)) fail('INVALID_STL', 'ASCII STL 包含无效二进制数据');
  const vertexCount = inspectAsciiStl(buffer);
  const geometry = allocateGeometry('stl', vertexCount, vertexCount / 3, 'STL ');
  let vertexWrite = 0;
  forEachUtf8Line(buffer, 'ASCII STL ', (rawLine) => {
    const parts = rawLine.trim().split(/\s+/);
    if (String(parts[0] || '').toLowerCase() !== 'vertex') return;
    const offset = vertexWrite * 3;
    geometry.positions[offset] = finiteNumber(parts[1], 'STL vertex.x');
    geometry.positions[offset + 1] = finiteNumber(parts[2], 'STL vertex.y');
    geometry.positions[offset + 2] = finiteNumber(parts[3], 'STL vertex.z');
    geometry.indices[vertexWrite] = vertexWrite;
    vertexWrite += 1;
  });
  return ensureGeometryBounds(geometry);
}

function parseStlGeometry(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 15) fail('INVALID_STL', 'STL 文件过短');
  if (buffer.length > MAX_SOURCE_BYTES) fail('SOURCE_TOO_LARGE', `STL 超过 ${MAX_SOURCE_BYTES} bytes`);
  if (buffer.length >= 84) {
    const triangleCount = buffer.readUInt32LE(80);
    const expectedLength = 84 + triangleCount * 50;
    const beginsWithSolid = buffer.subarray(0, 5).toString('ascii').toLowerCase() === 'solid';
    if (!beginsWithSolid && triangleCount > maximumBinaryStlTriangles()) fail('MODEL_TOO_COMPLEX', 'STL 三角面数量无效或超限');
    if (triangleCount > 0 && (!beginsWithSolid || expectedLength === buffer.length)) {
      return parseBinaryStl(buffer, triangleCount);
    }
  }
  return parseAsciiStl(buffer);
}

const GLB_JSON_CHUNK = 0x4E4F534A;
const GLB_BIN_CHUNK = 0x004E4942;
const COMPONENT_BYTES = Object.freeze({ 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 });
const TYPE_COMPONENTS = Object.freeze({ SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 });

function identityMatrix() {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

function multiplyMatrices(left, right) {
  const output = new Array(16).fill(0);
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      for (let inner = 0; inner < 4; inner += 1) output[column * 4 + row] += left[inner * 4 + row] * right[column * 4 + inner];
    }
  }
  return output;
}

function nodeMatrix(node) {
  if (Array.isArray(node?.matrix)) {
    if (node.matrix.length !== 16) fail('INVALID_GLB', 'GLB 节点 matrix 长度无效');
    return node.matrix.map((entry, index) => finiteNumber(entry, `GLB matrix[${index}]`));
  }
  const translation = Array.isArray(node?.translation) ? node.translation : [0, 0, 0];
  const rotation = Array.isArray(node?.rotation) ? node.rotation : [0, 0, 0, 1];
  const scale = Array.isArray(node?.scale) ? node.scale : [1, 1, 1];
  if (translation.length !== 3 || rotation.length !== 4 || scale.length !== 3) fail('INVALID_GLB', 'GLB 节点 TRS 长度无效');
  const [x, y, z, w] = rotation.map((entry, index) => finiteNumber(entry, `GLB rotation[${index}]`));
  const [sx, sy, sz] = scale.map((entry, index) => finiteNumber(entry, `GLB scale[${index}]`));
  const [tx, ty, tz] = translation.map((entry, index) => finiteNumber(entry, `GLB translation[${index}]`));
  const xx = x * x; const yy = y * y; const zz = z * z;
  const xy = x * y; const xz = x * z; const yz = y * z;
  const wx = w * x; const wy = w * y; const wz = w * z;
  return [
    (1 - 2 * (yy + zz)) * sx, (2 * (xy + wz)) * sx, (2 * (xz - wy)) * sx, 0,
    (2 * (xy - wz)) * sy, (1 - 2 * (xx + zz)) * sy, (2 * (yz + wx)) * sy, 0,
    (2 * (xz + wy)) * sz, (2 * (yz - wx)) * sz, (1 - 2 * (xx + yy)) * sz, 0,
    tx, ty, tz, 1,
  ];
}

function readGlbChunks(buffer) {
  let document = null;
  let binaryChunk = null;
  let offset = 12;
  let chunkCount = 0;
  while (offset < buffer.length) {
    if (offset + 8 > buffer.length) fail('INVALID_GLB', 'GLB chunk header 被截断');
    const chunkLength = buffer.readUInt32LE(offset);
    const chunkType = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + chunkLength;
    if (!Number.isSafeInteger(end) || end > buffer.length) fail('INVALID_GLB', 'GLB chunk 数据越界');
    chunkCount += 1;
    if (chunkCount > 128) fail('MODEL_TOO_COMPLEX', 'GLB chunk 数量超限');
    if (chunkType === GLB_JSON_CHUNK && !document) {
      if (chunkLength > MAX_GLB_JSON_BYTES) fail('MODEL_TOO_COMPLEX', `GLB JSON 超过 ${MAX_GLB_JSON_BYTES} bytes`);
      let jsonEnd = end;
      while (jsonEnd > start && [0x00, 0x09, 0x0A, 0x0D, 0x20].includes(buffer[jsonEnd - 1])) jsonEnd -= 1;
      try {
        document = JSON.parse(buffer.toString('utf8', start, jsonEnd));
      } catch (_) {
        fail('INVALID_GLB', 'GLB JSON 无法解析');
      }
    } else if (chunkType === GLB_BIN_CHUNK && !binaryChunk) {
      binaryChunk = buffer.subarray(start, end);
    }
    offset = end;
  }
  if (!document || typeof document !== 'object') fail('INVALID_GLB', 'GLB 缺少 JSON chunk');
  return { document, binaryChunk };
}

function countGlbStructure(document) {
  const keys = ['buffers', 'bufferViews', 'accessors', 'meshes', 'nodes', 'scenes', 'images'];
  let count = 0;
  for (const key of keys) {
    const entries = document[key];
    if (entries != null && !Array.isArray(entries)) fail('INVALID_GLB', `GLB ${key} 格式无效`);
    count += Array.isArray(entries) ? entries.length : 0;
    if (count > MAX_STRUCTURAL_ENTRIES) fail('MODEL_TOO_COMPLEX', 'GLB 结构条目数量超限');
  }
  for (const mesh of Array.isArray(document.meshes) ? document.meshes : []) {
    if (!mesh || !Array.isArray(mesh.primitives)) fail('INVALID_GLB', 'GLB mesh primitives 无效');
    count += mesh.primitives.length;
    if (count > MAX_STRUCTURAL_ENTRIES) fail('MODEL_TOO_COMPLEX', 'GLB 结构条目数量超限');
  }
  for (const node of Array.isArray(document.nodes) ? document.nodes : []) {
    if (node?.children != null && !Array.isArray(node.children)) fail('INVALID_GLB', 'GLB node children 无效');
    count += Array.isArray(node?.children) ? node.children.length : 0;
    if (count > MAX_STRUCTURAL_ENTRIES) fail('MODEL_TOO_COMPLEX', 'GLB 结构条目数量超限');
  }
  for (const scene of Array.isArray(document.scenes) ? document.scenes : []) {
    if (scene?.nodes != null && !Array.isArray(scene.nodes)) fail('INVALID_GLB', 'GLB scene nodes 无效');
    count += Array.isArray(scene?.nodes) ? scene.nodes.length : 0;
    if (count > MAX_STRUCTURAL_ENTRIES) fail('MODEL_TOO_COMPLEX', 'GLB 结构条目数量超限');
  }
  return count;
}

function parseGlbGeometry(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 20) fail('INVALID_GLB', 'GLB 文件过短');
  if (buffer.length > MAX_SOURCE_BYTES) fail('SOURCE_TOO_LARGE', `GLB 超过 ${MAX_SOURCE_BYTES} bytes`);
  if (buffer.readUInt32LE(0) !== 0x46546C67) fail('INVALID_GLB', 'GLB magic 无效');
  if (buffer.readUInt32LE(4) !== 2) fail('INVALID_GLB', '仅支持 GLB 2.0');
  if (buffer.readUInt32LE(8) !== buffer.length) fail('INVALID_GLB', 'GLB 声明长度与文件不一致');

  const { document, binaryChunk } = readGlbChunks(buffer);
  countGlbStructure(document);
  const buffers = Array.isArray(document.buffers) ? document.buffers : [];
  let hasForbiddenUri = false;
  for (const collection of [buffers, Array.isArray(document.images) ? document.images : []]) {
    for (const entry of collection) {
      if (typeof entry?.uri === 'string' && entry.uri && !entry.uri.startsWith('data:')) {
        hasForbiddenUri = true;
        break;
      }
    }
    if (hasForbiddenUri) break;
  }
  if (hasForbiddenUri) fail('EXTERNAL_REFERENCE_FORBIDDEN', '3D 预览禁止读取网络或目录外部引用');
  if (buffers.some((entry) => entry?.uri)) fail('EXTERNAL_REFERENCE_FORBIDDEN', 'GLB 几何 buffer 必须内嵌在文件中');
  if (!binaryChunk) fail('INVALID_GLB', 'GLB 缺少内嵌 BIN chunk');
  if (buffers.length > 1) fail('INVALID_GLB', 'GLB 包含多个无法安全映射的 buffer');
  if (buffers[0]?.byteLength != null) {
    const declared = Number(buffers[0].byteLength);
    if (!Number.isSafeInteger(declared) || declared < 0 || declared > binaryChunk.length) fail('INVALID_GLB', 'GLB buffer 长度无效');
  }

  const accessors = Array.isArray(document.accessors) ? document.accessors : [];
  const bufferViews = Array.isArray(document.bufferViews) ? document.bufferViews : [];
  const meshes = Array.isArray(document.meshes) ? document.meshes : [];
  const nodes = Array.isArray(document.nodes) ? document.nodes : [];

  const readComponent = (componentType, byteOffset) => {
    if (componentType === 5120) return binaryChunk.readInt8(byteOffset);
    if (componentType === 5121) return binaryChunk.readUInt8(byteOffset);
    if (componentType === 5122) return binaryChunk.readInt16LE(byteOffset);
    if (componentType === 5123) return binaryChunk.readUInt16LE(byteOffset);
    if (componentType === 5125) return binaryChunk.readUInt32LE(byteOffset);
    if (componentType === 5126) return binaryChunk.readFloatLE(byteOffset);
    fail('INVALID_GLB', `GLB componentType ${componentType} 不受支持`);
  };

  const accessorCache = new Map();
  const describeAccessor = (accessorIndex, expectedType, allowedComponents, maximumCount) => {
    const cacheKey = `${accessorIndex}:${expectedType}`;
    if (accessorCache.has(cacheKey)) return accessorCache.get(cacheKey);
    const accessor = accessors[accessorIndex];
    if (!accessor || accessor.sparse) fail('INVALID_GLB', 'GLB accessor 缺失或使用了不支持的 sparse 数据');
    if (accessor.type !== expectedType || !allowedComponents.includes(accessor.componentType)) fail('INVALID_GLB', `GLB ${expectedType} accessor 格式无效`);
    const view = bufferViews[accessor.bufferView];
    if (!view || Number(view.buffer || 0) !== 0) fail('INVALID_GLB', 'GLB bufferView 无效');
    const components = TYPE_COMPONENTS[accessor.type];
    const componentBytes = COMPONENT_BYTES[accessor.componentType];
    const count = Number(accessor.count);
    if (!Number.isSafeInteger(count) || count < 1 || count > maximumCount) fail('MODEL_TOO_COMPLEX', 'GLB accessor 数量无效或超限');
    const elementBytes = components * componentBytes;
    const stride = Number(view.byteStride || elementBytes);
    const viewOffset = Number(view.byteOffset || 0);
    const accessorOffset = Number(accessor.byteOffset || 0);
    const viewLength = Number(view.byteLength);
    if (![stride, viewOffset, accessorOffset, viewLength].every(Number.isSafeInteger)
      || stride < elementBytes || stride > 4096 || viewOffset < 0 || accessorOffset < 0 || viewLength < 1) {
      fail('INVALID_GLB', 'GLB accessor 布局无效');
    }
    const baseOffset = viewOffset + accessorOffset;
    const viewEnd = viewOffset + viewLength;
    const finalEnd = baseOffset + (count - 1) * stride + elementBytes;
    if (![baseOffset, viewEnd, finalEnd].every(Number.isSafeInteger) || finalEnd > viewEnd || finalEnd > binaryChunk.length) fail('INVALID_GLB', 'GLB accessor 数据越界');
    const descriptor = { accessorIndex, componentType: accessor.componentType, components, componentBytes, count, stride, baseOffset };
    accessorCache.set(cacheKey, descriptor);
    return descriptor;
  };
  const accessorValue = (descriptor, itemIndex, componentIndex = 0) => readComponent(
    descriptor.componentType,
    descriptor.baseOffset + itemIndex * descriptor.stride + componentIndex * descriptor.componentBytes,
  );

  const meshCache = new Map();
  const describeMesh = (meshIndex) => {
    if (meshCache.has(meshIndex)) return meshCache.get(meshIndex);
    const mesh = meshes[meshIndex];
    if (!mesh || !Array.isArray(mesh.primitives)) fail('INVALID_GLB', `GLB mesh ${meshIndex} 无效`);
    const primitives = [];
    let vertexCount = 0;
    let triangleCount = 0;
    for (const primitive of mesh.primitives) {
      if (primitive?.mode != null && primitive.mode !== 4) continue;
      const positionAccessor = primitive?.attributes?.POSITION;
      if (!Number.isSafeInteger(positionAccessor)) continue;
      const positions = describeAccessor(positionAccessor, 'VEC3', [5126], MAX_VERTICES);
      const indices = primitive.indices == null
        ? null
        : describeAccessor(primitive.indices, 'SCALAR', [5121, 5123, 5125], MAX_TRIANGLES * 3);
      const indexCount = indices ? indices.count : positions.count;
      if (indexCount % 3 !== 0) fail('INVALID_GLB', 'GLB TRIANGLES 索引数量不是 3 的倍数');
      vertexCount += positions.count;
      triangleCount += indexCount / 3;
      if (vertexCount > MAX_VERTICES || triangleCount > MAX_TRIANGLES) fail('MODEL_TOO_COMPLEX', 'GLB mesh 复杂度超限');
      primitives.push({ positions, indices, triangleCount: indexCount / 3 });
    }
    if (!primitives.length) fail('EMPTY_GEOMETRY', `GLB mesh ${meshIndex} 没有可渲染三角面`);
    const descriptor = { primitives, vertexCount, triangleCount };
    meshCache.set(meshIndex, descriptor);
    return descriptor;
  };

  const referencedChildren = new Uint8Array(nodes.length);
  for (const node of nodes) {
    for (const child of Array.isArray(node?.children) ? node.children : []) {
      if (!Number.isSafeInteger(child) || child < 0 || child >= nodes.length) fail('INVALID_GLB', 'GLB 节点索引越界');
      referencedChildren[child] = 1;
    }
  }
  const selectedSceneIndex = Number.isSafeInteger(document.scene) ? document.scene : 0;
  const selectedScene = Array.isArray(document.scenes) ? document.scenes[selectedSceneIndex] : null;
  const roots = Array.isArray(selectedScene?.nodes) && selectedScene.nodes.length
    ? selectedScene.nodes.slice()
    : nodes.map((_, index) => index).filter((index) => !referencedChildren[index]);

  const walkInstances = (visitor) => {
    let visits = 0;
    const activeNodes = new Uint8Array(nodes.length);
    const visitNode = (nodeIndex, parentMatrix, depth) => {
      if (depth > MAX_NODE_DEPTH) fail('INVALID_GLB', 'GLB 节点层级过深');
      if (!Number.isSafeInteger(nodeIndex) || !nodes[nodeIndex]) fail('INVALID_GLB', 'GLB 节点索引越界');
      if (activeNodes[nodeIndex]) fail('INVALID_GLB', 'GLB 节点图包含循环');
      visits += 1;
      if (visits > MAX_NODE_VISITS) fail('MODEL_TOO_COMPLEX', 'GLB 场景实例数量超限');
      const node = nodes[nodeIndex];
      const matrix = multiplyMatrices(parentMatrix, nodeMatrix(node));
      activeNodes[nodeIndex] = 1;
      try {
        if (Number.isSafeInteger(node.mesh)) visitor(describeMesh(node.mesh), matrix);
        for (const child of Array.isArray(node.children) ? node.children : []) visitNode(child, matrix, depth + 1);
      } finally {
        activeNodes[nodeIndex] = 0;
      }
    };
    if (nodes.length) {
      for (const root of roots) visitNode(root, identityMatrix(), 0);
    } else {
      for (let meshIndex = 0; meshIndex < meshes.length; meshIndex += 1) visitor(describeMesh(meshIndex), identityMatrix());
    }
  };

  // Count the fully-instantiated scene before allocating either typed array.
  let vertexCount = 0;
  let triangleCount = 0;
  walkInstances((mesh) => {
    vertexCount += mesh.vertexCount;
    triangleCount += mesh.triangleCount;
    if (vertexCount > MAX_VERTICES || triangleCount > MAX_TRIANGLES) fail('MODEL_TOO_COMPLEX', 'GLB 场景实例化后复杂度超限');
  });
  const geometry = allocateGeometry('glb', vertexCount, triangleCount, 'GLB ');
  let vertexWrite = 0;
  let triangleWrite = 0;
  walkInstances((mesh, matrix) => {
    for (const primitive of mesh.primitives) {
      const primitiveVertexOffset = vertexWrite;
      for (let itemIndex = 0; itemIndex < primitive.positions.count; itemIndex += 1) {
        const x = finiteNumber(accessorValue(primitive.positions, itemIndex, 0), 'GLB POSITION.x');
        const y = finiteNumber(accessorValue(primitive.positions, itemIndex, 1), 'GLB POSITION.y');
        const z = finiteNumber(accessorValue(primitive.positions, itemIndex, 2), 'GLB POSITION.z');
        const w = matrix[3] * x + matrix[7] * y + matrix[11] * z + matrix[15];
        const divisor = w && w !== 1 ? w : 1;
        const offset = vertexWrite * 3;
        geometry.positions[offset] = finiteNumber((matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12]) / divisor, 'GLB transformed x');
        geometry.positions[offset + 1] = finiteNumber((matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13]) / divisor, 'GLB transformed y');
        geometry.positions[offset + 2] = finiteNumber((matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14]) / divisor, 'GLB transformed z');
        vertexWrite += 1;
      }
      const indexCount = primitive.triangleCount * 3;
      for (let index = 0; index < indexCount; index += 1) {
        const sourceIndex = primitive.indices ? accessorValue(primitive.indices, index) : index;
        if (!Number.isSafeInteger(sourceIndex) || sourceIndex < 0 || sourceIndex >= primitive.positions.count) fail('INVALID_GLB', 'GLB primitive 索引越界');
        geometry.indices[triangleWrite * 3 + (index % 3)] = primitiveVertexOffset + sourceIndex;
        if (index % 3 === 2) triangleWrite += 1;
      }
    }
  });
  if (vertexWrite !== vertexCount || triangleWrite !== triangleCount) fail('INVALID_GLB', 'GLB 场景计数在解析期间发生变化');
  return ensureGeometryBounds(geometry);
}

function parseModelGeometry(sourcePath) {
  const absolute = path.resolve(String(sourcePath || ''));
  let stat;
  try { stat = fs.statSync(absolute); } catch (_) { fail('SOURCE_NOT_FOUND', '3D 模型文件不存在'); }
  if (!stat.isFile()) fail('SOURCE_NOT_FILE', '3D 模型路径不是文件');
  if (stat.size < 1) fail('EMPTY_SOURCE', '3D 模型文件为空');
  // Reject by stat before fs.readFileSync so a sparse or hostile source cannot
  // transiently allocate a buffer over the renderer's process budget.
  if (stat.size > MAX_SOURCE_BYTES) fail('SOURCE_TOO_LARGE', `3D 模型超过 ${MAX_SOURCE_BYTES} bytes`);
  const extension = path.extname(absolute).toLowerCase();
  if (!['.obj', '.stl', '.glb'].includes(extension)) fail('UNSUPPORTED_FORMAT', '3D 预览仅支持 OBJ、STL 和 GLB');
  const buffer = fs.readFileSync(absolute);
  if (extension === '.obj') return parseObjGeometry(buffer);
  if (extension === '.stl') return parseStlGeometry(buffer);
  return parseGlbGeometry(buffer);
}

function renderGeometrySvg(geometry, width, height) {
  const { positions, indices, vertexCount, triangleCount } = geometry;
  let minX = Infinity; let minY = Infinity; let minZ = Infinity;
  let maxX = -Infinity; let maxY = -Infinity; let maxZ = -Infinity;
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    const offset = vertex * 3;
    const x = positions[offset]; const y = positions[offset + 1]; const z = positions[offset + 2];
    minX = Math.min(minX, x); minY = Math.min(minY, y); minZ = Math.min(minZ, z);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); maxZ = Math.max(maxZ, z);
  }
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  const centerZ = (minZ + maxZ) / 2;
  const yaw = -Math.PI / 4;
  const pitch = -Math.PI / 7;
  const cosYaw = Math.cos(yaw); const sinYaw = Math.sin(yaw);
  const cosPitch = Math.cos(pitch); const sinPitch = Math.sin(pitch);
  const rotateInto = (vertexIndex, output, outputOffset = 0) => {
    const offset = vertexIndex * 3;
    const sourceX = positions[offset] - centerX;
    const sourceY = positions[offset + 1] - centerY;
    const sourceZ = positions[offset + 2] - centerZ;
    const x = cosYaw * sourceX + sinYaw * sourceZ;
    const z = -sinYaw * sourceX + cosYaw * sourceZ;
    output[outputOffset] = x;
    output[outputOffset + 1] = cosPitch * sourceY - sinPitch * z;
    output[outputOffset + 2] = sinPitch * sourceY + cosPitch * z;
  };

  let projectedMinX = Infinity; let projectedMaxX = -Infinity;
  let projectedMinY = Infinity; let projectedMaxY = -Infinity;
  const projectedVertex = new Float64Array(3);
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    rotateInto(vertex, projectedVertex);
    projectedMinX = Math.min(projectedMinX, projectedVertex[0]); projectedMaxX = Math.max(projectedMaxX, projectedVertex[0]);
    projectedMinY = Math.min(projectedMinY, projectedVertex[1]); projectedMaxY = Math.max(projectedMaxY, projectedVertex[1]);
  }
  const span = Math.max(projectedMaxX - projectedMinX, projectedMaxY - projectedMinY);
  if (!Number.isFinite(span) || span <= 1e-12) fail('EMPTY_GEOMETRY', '模型投影尺寸为零');
  const scale = Math.min(width, height) * 0.72 / span;
  const modelCenterX = (projectedMinX + projectedMaxX) / 2;
  const modelCenterY = (projectedMinY + projectedMaxY) / 2;
  const stride = Math.max(1, Math.ceil(triangleCount / MAX_RENDER_TRIANGLES));
  const faces = [];
  const rotated = new Float64Array(9);
  for (let triangleIndex = 0; triangleIndex < triangleCount; triangleIndex += stride) {
    const offset = triangleIndex * 3;
    for (let point = 0; point < 3; point += 1) {
      rotateInto(indices[offset + point], rotated, point * 3);
    }
    const x0 = width / 2 + (rotated[0] - modelCenterX) * scale;
    const y0 = height / 2 - (rotated[1] - modelCenterY) * scale;
    const x1 = width / 2 + (rotated[3] - modelCenterX) * scale;
    const y1 = height / 2 - (rotated[4] - modelCenterY) * scale;
    const x2 = width / 2 + (rotated[6] - modelCenterX) * scale;
    const y2 = height / 2 - (rotated[7] - modelCenterY) * scale;
    const area = Math.abs((x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0));
    if (area < 0.08) continue;
    const abx = rotated[3] - rotated[0]; const aby = rotated[4] - rotated[1]; const abz = rotated[5] - rotated[2];
    const acx = rotated[6] - rotated[0]; const acy = rotated[7] - rotated[1]; const acz = rotated[8] - rotated[2];
    const normalX = aby * acz - abz * acy;
    const normalY = abz * acx - abx * acz;
    const normalZ = abx * acy - aby * acx;
    const normalLength = Math.hypot(normalX, normalY, normalZ) || 1;
    const unitX = normalX / normalLength; const unitY = normalY / normalLength; const unitZ = normalZ / normalLength;
    const light = Math.min(1, Math.max(0, 0.35 + Math.abs(unitX * 0.28 - unitY * 0.38 + unitZ * 0.78) * 0.65));
    faces.push({
      x0, y0, x1, y1, x2, y2,
      depth: (rotated[2] + rotated[5] + rotated[8]) / 3,
      hue: Math.round(188 + unitX * 24 + unitY * 10),
      light,
    });
  }
  if (!faces.length) fail('EMPTY_GEOMETRY', '模型没有可见三角面');
  faces.sort((left, right) => left.depth - right.depth);
  const polygons = faces.map((face) => {
    const points = `${face.x0.toFixed(2)},${face.y0.toFixed(2)} ${face.x1.toFixed(2)},${face.y1.toFixed(2)} ${face.x2.toFixed(2)},${face.y2.toFixed(2)}`;
    const lightness = Math.round(27 + face.light * 42);
    return `<polygon points="${points}" fill="hsl(${face.hue} 68% ${lightness}%)" stroke="rgba(210,246,255,.58)" stroke-width=".72" stroke-linejoin="round"/>`;
  }).join('');
  const gridLines = Array.from({ length: 9 }, (_, index) => {
    const y = height * (0.68 + index * 0.027);
    return `<line x1="${width * 0.12}" y1="${y.toFixed(2)}" x2="${width * 0.88}" y2="${y.toFixed(2)}"/>`;
  }).join('');
  return {
    renderedTriangles: faces.length,
    svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><defs><radialGradient id="bg" cx="50%" cy="38%" r="74%"><stop offset="0" stop-color="#263b55"/><stop offset=".58" stop-color="#111d2e"/><stop offset="1" stop-color="#070c14"/></radialGradient><filter id="shadow" x="-30%" y="-30%" width="160%" height="180%"><feDropShadow dx="0" dy="10" stdDeviation="10" flood-color="#000" flood-opacity=".52"/></filter></defs><rect width="100%" height="100%" fill="url(#bg)"/><g stroke="rgba(105,184,215,.10)" stroke-width="1">${gridLines}</g><ellipse cx="${width / 2}" cy="${height * 0.79}" rx="${width * 0.27}" ry="${height * 0.055}" fill="rgba(0,0,0,.38)"/><g filter="url(#shadow)">${polygons}</g><rect x="1" y="1" width="${width - 2}" height="${height - 2}" rx="18" fill="none" stroke="rgba(173,232,255,.16)" stroke-width="2"/></svg>`,
  };
}

async function renderModelPreview({ sourcePath, targetPath, width = 512, height = 512 } = {}) {
  const normalizedWidth = Number(width);
  const normalizedHeight = Number(height);
  if (!Number.isSafeInteger(normalizedWidth) || !Number.isSafeInteger(normalizedHeight) || normalizedWidth < 128 || normalizedWidth > 1024 || normalizedHeight < 128 || normalizedHeight > 1024) {
    fail('INVALID_SIZE', '3D 预览宽高必须是 128-1024 的整数');
  }
  if (!sourcePath) fail('SOURCE_REQUIRED', '缺少 3D 模型路径');
  if (!targetPath) fail('TARGET_REQUIRED', '缺少 3D 预览输出路径');
  const absoluteTarget = path.resolve(String(targetPath));
  if (path.extname(absoluteTarget).toLowerCase() !== '.webp') fail('INVALID_TARGET', '3D 预览输出必须使用 .webp');
  const geometry = parseModelGeometry(sourcePath);
  const rendered = renderGeometrySvg(geometry, normalizedWidth, normalizedHeight);
  fs.mkdirSync(path.dirname(absoluteTarget), { recursive: true });
  const tempPath = path.join(path.dirname(absoluteTarget), `.${path.basename(absoluteTarget)}.tmp-${process.pid}-${crypto.randomUUID()}.webp`);
  try {
    await sharp(Buffer.from(rendered.svg), { density: 144 })
      .resize(normalizedWidth, normalizedHeight, { fit: 'fill' })
      .webp({ quality: 84, effort: 4, smartSubsample: true })
      .toFile(tempPath);
    fs.renameSync(tempPath, absoluteTarget);
  } catch (error) {
    try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch (_) { /* best effort cleanup */ }
    if (error instanceof ModelPreviewError) throw error;
    fail('RENDER_FAILED', `3D 预览渲染失败：${String(error?.message || error).slice(0, 300)}`);
  }
  const output = fs.readFileSync(absoluteTarget);
  return {
    targetPath: absoluteTarget,
    width: normalizedWidth,
    height: normalizedHeight,
    vertexCount: geometry.vertexCount,
    triangleCount: geometry.triangleCount,
    renderedTriangleCount: rendered.renderedTriangles,
    format: geometry.format,
    mimeType: 'image/webp',
    bytes: output.length,
    sha256: crypto.createHash('sha256').update(output).digest('hex'),
  };
}

module.exports = {
  MODEL_PREVIEW_LIMITS,
  ModelPreviewError,
  renderModelPreview,
  parseModelGeometry,
  parseObjGeometry,
  parseStlGeometry,
  parseGlbGeometry,
  renderGeometrySvg,
};
