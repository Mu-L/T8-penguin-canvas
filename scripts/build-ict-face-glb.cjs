#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');

const REPOSITORY = 'https://raw.githubusercontent.com/USC-ICT/ICT-FaceKit/master';
const DEFAULT_SOURCE = path.join(os.tmpdir(), 't8-ict-facekit');
const DEFAULT_OUTPUT = path.resolve('public/assets/face-expression/t8-ict-neutral-head-v1.glb');
const SCALE = 0.09;
const OFFSET = [0, 0.115, -0.174];
const IRIS_FORWARD_OFFSET = 0.006;

const TARGETS = [
  ['browDownLeft', ['browDown_L']],
  ['browDownRight', ['browDown_R']],
  ['browInnerUp', ['browInnerUp_L', 'browInnerUp_R']],
  ['browOuterUpLeft', ['browOuterUp_L']],
  ['browOuterUpRight', ['browOuterUp_R']],
  ['cheekPuff', ['cheekPuff_L', 'cheekPuff_R']],
  ['cheekSquintLeft', ['cheekSquint_L']],
  ['cheekSquintRight', ['cheekSquint_R']],
  ['eyeBlinkLeft', ['eyeBlink_L']],
  ['eyeBlinkRight', ['eyeBlink_R']],
  ['eyeLookDownLeft', ['eyeLookDown_L']],
  ['eyeLookDownRight', ['eyeLookDown_R']],
  ['eyeLookInLeft', ['eyeLookIn_L']],
  ['eyeLookInRight', ['eyeLookIn_R']],
  ['eyeLookOutLeft', ['eyeLookOut_L']],
  ['eyeLookOutRight', ['eyeLookOut_R']],
  ['eyeLookUpLeft', ['eyeLookUp_L']],
  ['eyeLookUpRight', ['eyeLookUp_R']],
  ['eyeSquintLeft', ['eyeSquint_L']],
  ['eyeSquintRight', ['eyeSquint_R']],
  ['eyeWideLeft', ['eyeWide_L']],
  ['eyeWideRight', ['eyeWide_R']],
  ['jawForward', ['jawForward']],
  ['jawLeft', ['jawLeft']],
  ['jawOpen', ['jawOpen']],
  ['jawRight', ['jawRight']],
  ['mouthClose', ['mouthClose']],
  ['mouthDimpleLeft', ['mouthDimple_L']],
  ['mouthDimpleRight', ['mouthDimple_R']],
  ['mouthFrownLeft', ['mouthFrown_L']],
  ['mouthFrownRight', ['mouthFrown_R']],
  ['mouthFunnel', ['mouthFunnel']],
  ['mouthLeft', ['mouthLeft']],
  ['mouthLowerDownLeft', ['mouthLowerDown_L']],
  ['mouthLowerDownRight', ['mouthLowerDown_R']],
  ['mouthPressLeft', ['mouthPress_L']],
  ['mouthPressRight', ['mouthPress_R']],
  ['mouthPucker', ['mouthPucker']],
  ['mouthRight', ['mouthRight']],
  ['mouthRollLower', ['mouthRollLower']],
  ['mouthRollUpper', ['mouthRollUpper']],
  ['mouthShrugLower', ['mouthShrugLower']],
  ['mouthShrugUpper', ['mouthShrugUpper']],
  ['mouthSmileLeft', ['mouthSmile_L']],
  ['mouthSmileRight', ['mouthSmile_R']],
  ['mouthStretchLeft', ['mouthStretch_L']],
  ['mouthStretchRight', ['mouthStretch_R']],
  ['mouthUpperUpLeft', ['mouthUpperUp_L']],
  ['mouthUpperUpRight', ['mouthUpperUp_R']],
  ['noseSneerLeft', ['noseSneer_L']],
  ['noseSneerRight', ['noseSneer_R']],
  ['tongueOut', []],
];

const MATERIALS = [
  ['M_Face', [0.72, 0.73, 0.72, 1], 0.76, 0.0],
  ['M_BackHead', [0.69, 0.70, 0.69, 1], 0.8, 0.0],
  ['M_GumsTongue', [0.34, 0.12, 0.14, 1], 0.58, 0.0],
  ['M_Teeth', [0.88, 0.87, 0.82, 1], 0.48, 0.0],
  ['M_ScleraLeft', [0.82, 0.83, 0.8, 1], 0.34, 0.0],
  ['M_IrisLeft', [0.2, 0.25, 0.24, 1], 0.46, 0.0],
  ['M_ScleraRight', [0.82, 0.83, 0.8, 1], 0.34, 0.0],
  ['M_IrisRight', [0.2, 0.25, 0.24, 1], 0.46, 0.0],
  ['M_LacrimalFluid', [0.72, 0.75, 0.75, 0.16], 0.16, 0.0, 'BLEND'],
  ['M_EyeBlend', [0.62, 0.63, 0.62, 0.06], 0.62, 0.0, 'BLEND'],
  ['M_EyeOcclusion', [0.12, 0.13, 0.13, 0.12], 0.68, 0.0, 'BLEND'],
  ['M_EyeLashes', [0.18, 0.18, 0.17, 0.4], 0.78, 0.0, 'BLEND'],
];

function readArg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? path.resolve(process.argv[index + 1]) : fallback;
}

function align4(value) {
  return (value + 3) & ~3;
}

async function ensureSource(sourceDir) {
  fs.mkdirSync(sourceDir, { recursive: true });
  const names = new Set(['generic_neutral_mesh', ...TARGETS.flatMap(([, sources]) => sources)]);
  const missing = [...names].filter((name) => !fs.existsSync(path.join(sourceDir, `${name}.obj`)));
  if (!missing.length) return;
  console.log(`Downloading ${missing.length} ICT FaceKit meshes...`);
  let cursor = 0;
  async function worker() {
    while (cursor < missing.length) {
      const name = missing[cursor++];
      const response = await fetch(`${REPOSITORY}/FaceXModel/${name}.obj`);
      if (!response.ok) throw new Error(`Failed to download ${name}.obj: ${response.status}`);
      fs.writeFileSync(path.join(sourceDir, `${name}.obj`), Buffer.from(await response.arrayBuffer()));
      process.stdout.write('.');
    }
  }
  await Promise.all(Array.from({ length: Math.min(8, missing.length) }, worker));
  process.stdout.write('\n');
  for (const name of ['LICENSE']) {
    const target = path.join(sourceDir, name);
    if (fs.existsSync(target)) continue;
    const response = await fetch(`${REPOSITORY}/${name}`);
    if (!response.ok) throw new Error(`Failed to download ${name}: ${response.status}`);
    fs.writeFileSync(target, Buffer.from(await response.arrayBuffer()));
  }
}

function parsePositions(file) {
  const positions = [];
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.startsWith('v ')) continue;
    const parts = line.trim().split(/\s+/);
    positions.push([Number(parts[1]), Number(parts[2]), Number(parts[3])]);
  }
  return positions;
}

function transformPosition(position) {
  return [
    position[0] * SCALE + OFFSET[0],
    position[1] * SCALE + OFFSET[1],
    position[2] * SCALE + OFFSET[2],
  ];
}

function parseNeutral(file) {
  const sourcePositions = [];
  const sourceUvs = [];
  const vertices = [];
  const uvs = [];
  const originalIndices = [];
  const vertexMap = new Map();
  const materialIndices = new Map(MATERIALS.map(([name], index) => [name, index]));
  const triangles = MATERIALS.map(() => []);
  const materialVertices = MATERIALS.map(() => new Set());
  let material = 0;

  function expandedIndex(ref) {
    const [positionToken, uvToken] = ref.split('/');
    const positionIndex = Number(positionToken) - 1;
    const uvIndex = uvToken ? Number(uvToken) - 1 : -1;
    const key = `${positionIndex}/${uvIndex}`;
    const existing = vertexMap.get(key);
    if (existing != null) return existing;
    const index = originalIndices.length;
    vertexMap.set(key, index);
    originalIndices.push(positionIndex);
    vertices.push(...transformPosition(sourcePositions[positionIndex]));
    const uv = sourceUvs[uvIndex] || [0, 0];
    uvs.push(uv[0], 1 - uv[1]);
    return index;
  }

  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (line.startsWith('v ')) {
      const parts = line.trim().split(/\s+/);
      sourcePositions.push([Number(parts[1]), Number(parts[2]), Number(parts[3])]);
    } else if (line.startsWith('vt ')) {
      const parts = line.trim().split(/\s+/);
      sourceUvs.push([Number(parts[1]), Number(parts[2])]);
    } else if (line.startsWith('usemtl ')) {
      material = materialIndices.get(line.slice(7).trim()) ?? 0;
    } else if (line.startsWith('f ')) {
      const refs = line.trim().split(/\s+/).slice(1).map(expandedIndex);
      for (let index = 1; index + 1 < refs.length; index += 1) {
        const tri = [refs[0], refs[index], refs[index + 1]];
        triangles[material].push(...tri);
        for (const vertex of tri) materialVertices[material].add(originalIndices[vertex]);
      }
    }
  }

  // Keep the untextured iris just above the sclera without pushing it through
  // the eyelids when the eyeBlink morph closes the eye.
  const irisVertices = new Set([...materialVertices[5], ...materialVertices[7]]);
  for (let index = 0; index < originalIndices.length; index += 1) {
    if (irisVertices.has(originalIndices[index])) vertices[index * 3 + 2] += IRIS_FORWARD_OFFSET;
  }

  const normals = new Float32Array(vertices.length);
  for (const indices of triangles) {
    for (let index = 0; index < indices.length; index += 3) {
      const ia = indices[index] * 3;
      const ib = indices[index + 1] * 3;
      const ic = indices[index + 2] * 3;
      const ab = [vertices[ib] - vertices[ia], vertices[ib + 1] - vertices[ia + 1], vertices[ib + 2] - vertices[ia + 2]];
      const ac = [vertices[ic] - vertices[ia], vertices[ic + 1] - vertices[ia + 1], vertices[ic + 2] - vertices[ia + 2]];
      const cross = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
      for (const offset of [ia, ib, ic]) {
        normals[offset] += cross[0]; normals[offset + 1] += cross[1]; normals[offset + 2] += cross[2];
      }
    }
  }
  for (let index = 0; index < normals.length; index += 3) {
    const length = Math.hypot(normals[index], normals[index + 1], normals[index + 2]) || 1;
    normals[index] /= length; normals[index + 1] /= length; normals[index + 2] /= length;
  }
  return {
    sourcePositions,
    positions: new Float32Array(vertices),
    normals,
    uvs: new Float32Array(uvs),
    originalIndices,
    triangles: triangles.map((values) => new Uint32Array(values)),
    materialVertices,
  };
}

function buildTongueTarget(neutral) {
  const result = new Float32Array(neutral.positions.length);
  const gumsTongue = neutral.materialVertices[2];
  for (let index = 0; index < neutral.originalIndices.length; index += 1) {
    const originalIndex = neutral.originalIndices[index];
    if (!gumsTongue.has(originalIndex)) continue;
    const [x, y, z] = neutral.sourcePositions[originalIndex];
    const center = Math.max(0, 1 - Math.abs(x) / 2.3);
    const vertical = Math.max(0, 1 - Math.abs(y + 3.45) / 1.45);
    const front = Math.max(0, Math.min(1, (z - 7.8) / 2.4));
    const weight = center * vertical * front;
    if (weight <= 0) continue;
    result[index * 3 + 1] = -0.42 * SCALE * weight;
    result[index * 3 + 2] = 1.72 * SCALE * weight;
  }
  return result;
}

function buildMorphTarget(name, sources, sourceDir, neutral) {
  if (name === 'tongueOut') return buildTongueTarget(neutral);
  const result = new Float32Array(neutral.positions.length);
  for (const sourceName of sources) {
    const positions = parsePositions(path.join(sourceDir, `${sourceName}.obj`));
    if (positions.length !== neutral.sourcePositions.length) {
      throw new Error(`${sourceName}.obj topology mismatch: ${positions.length}`);
    }
    for (let index = 0; index < neutral.originalIndices.length; index += 1) {
      const originalIndex = neutral.originalIndices[index];
      const base = neutral.sourcePositions[originalIndex];
      const target = positions[originalIndex];
      result[index * 3] += (target[0] - base[0]) * SCALE;
      result[index * 3 + 1] += (target[1] - base[1]) * SCALE;
      result[index * 3 + 2] += (target[2] - base[2]) * SCALE;
    }
  }
  return result;
}

function rangeForPositions(values) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let index = 0; index < values.length; index += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      min[axis] = Math.min(min[axis], values[index + axis]);
      max[axis] = Math.max(max[axis], values[index + axis]);
    }
  }
  return { min, max };
}

function writeGlb(output, neutral, morphTargets) {
  const chunks = [];
  const bufferViews = [];
  const accessors = [];
  let byteLength = 0;

  function addBufferView(typed, target) {
    const source = Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength);
    const padding = align4(source.length) - source.length;
    const buffer = padding ? Buffer.concat([source, Buffer.alloc(padding)]) : source;
    const index = bufferViews.length;
    bufferViews.push({ buffer: 0, byteOffset: byteLength, byteLength: source.length, ...(target ? { target } : {}) });
    chunks.push(buffer);
    byteLength += buffer.length;
    return index;
  }

  function addAccessor(typed, componentType, type, count, options = {}) {
    const index = accessors.length;
    accessors.push({ bufferView: addBufferView(typed, options.target), byteOffset: 0, componentType, count, type, ...(options.min ? { min: options.min } : {}), ...(options.max ? { max: options.max } : {}) });
    return index;
  }

  const bounds = rangeForPositions(neutral.positions);
  const positionAccessor = addAccessor(neutral.positions, 5126, 'VEC3', neutral.positions.length / 3, { target: 34962, ...bounds });
  const normalAccessor = addAccessor(neutral.normals, 5126, 'VEC3', neutral.normals.length / 3, { target: 34962 });
  const uvAccessor = addAccessor(neutral.uvs, 5126, 'VEC2', neutral.uvs.length / 2, { target: 34962 });
  const morphAccessors = morphTargets.map((target) => addAccessor(target, 5126, 'VEC3', target.length / 3, { target: 34962 }));
  const indexAccessors = neutral.triangles.map((indices) => addAccessor(indices, 5125, 'SCALAR', indices.length, { target: 34963 }));

  const materials = MATERIALS.map(([name, baseColorFactor, roughnessFactor, metallicFactor, alphaMode]) => ({
    name,
    pbrMetallicRoughness: { baseColorFactor, roughnessFactor, metallicFactor },
    ...(alphaMode ? { alphaMode } : {}),
    ...(/M_(Iris|Lacrimal|EyeBlend|EyeOcclusion|EyeLashes)/i.test(name) ? { doubleSided: true } : {}),
  }));
  const primitives = indexAccessors.map((indices, material) => ({
    attributes: { POSITION: positionAccessor, NORMAL: normalAccessor, TEXCOORD_0: uvAccessor },
    indices,
    material,
    mode: 4,
    targets: morphAccessors.map((POSITION) => ({ POSITION })),
  }));

  const gltf = {
    asset: { version: '2.0', generator: 'T8 ICT FaceKit GLB Builder', copyright: 'USC ICT FaceKit, MIT License' },
    scene: 0,
    scenes: [{ name: 'T8 Neutral Face Studio', nodes: [0] }],
    nodes: [{ name: 'T8NeutralHumanHead', mesh: 0 }],
    meshes: [{ name: 'T8ICTNeutralHeadV1', primitives, weights: TARGETS.map(() => 0), extras: { targetNames: TARGETS.map(([name]) => name) } }],
    materials,
    accessors,
    bufferViews,
    buffers: [{ byteLength }],
    extras: {
      t8Asset: 'face-expression-neutral-head',
      adapterId: 't8-ict-neutral-head-v1',
      source: 'https://github.com/USC-ICT/ICT-FaceKit',
      license: 'MIT',
      channelCount: TARGETS.length,
    },
  };

  const jsonSource = Buffer.from(JSON.stringify(gltf));
  const jsonPadding = align4(jsonSource.length) - jsonSource.length;
  const json = jsonPadding ? Buffer.concat([jsonSource, Buffer.alloc(jsonPadding, 0x20)]) : jsonSource;
  const binary = Buffer.concat(chunks);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + json.length + 8 + binary.length, 8);
  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(json.length, 0);
  jsonHeader.writeUInt32LE(0x4e4f534a, 4);
  const binaryHeader = Buffer.alloc(8);
  binaryHeader.writeUInt32LE(binary.length, 0);
  binaryHeader.writeUInt32LE(0x004e4942, 4);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, Buffer.concat([header, jsonHeader, json, binaryHeader, binary]));
}

async function main() {
  const sourceDir = readArg('--source', process.env.T8_ICT_FACEKIT_SOURCE ? path.resolve(process.env.T8_ICT_FACEKIT_SOURCE) : DEFAULT_SOURCE);
  const output = readArg('--output', DEFAULT_OUTPUT);
  await ensureSource(sourceDir);
  console.log('Parsing neutral topology...');
  const neutral = parseNeutral(path.join(sourceDir, 'generic_neutral_mesh.obj'));
  console.log(`Building ${TARGETS.length} expression targets for ${neutral.originalIndices.length} render vertices...`);
  const morphTargets = TARGETS.map(([name, sources]) => {
    process.stdout.write(`${name} `);
    return buildMorphTarget(name, sources, sourceDir, neutral);
  });
  process.stdout.write('\n');
  writeGlb(output, neutral, morphTargets);
  const sizeMb = fs.statSync(output).size / 1024 / 1024;
  console.log(`Wrote ${output} (${sizeMb.toFixed(2)} MB)`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
