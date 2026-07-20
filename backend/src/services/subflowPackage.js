const crypto = require('crypto');
const path = require('path');
const yauzl = require('yauzl');
const yazl = require('yazl');

const PACKAGE_SCHEMA = 't8-subflow-package';
const PACKAGE_VERSION = 1;
const FIXED_ZIP_TIME = new Date('1980-01-01T00:00:00.000Z');
const DEFAULT_LIMITS = Object.freeze({
  archiveBytes: 100 * 1024 * 1024,
  entryBytes: 50 * 1024 * 1024,
  totalBytes: 250 * 1024 * 1024,
  entryCount: 512,
  pathDepth: 8,
  pathLength: 240,
  compressionRatio: 200,
  manifestBytes: 1024 * 1024,
  jsonDepth: 64,
  jsonNodes: 100000,
  jsonKeys: 100000,
  jsonStringBytes: 2 * 1024 * 1024,
  jsonArrayLength: 20000,
  definitionNodes: 5000,
  definitionEdges: 15000,
  definitionPorts: 2000,
  definitionParameters: 2000,
  dependencyCount: 128,
});
const BLOCKED_EXTENSIONS = new Set([
  '.exe', '.dll', '.com', '.scr', '.msi', '.bat', '.cmd', '.ps1', '.vbs', '.js', '.cjs', '.mjs', '.html', '.htm', '.svg', '.jar', '.sh', '.app', '.lnk', '.url',
]);
const ASSET_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.webp', '.gif', '.mp4', '.webm', '.mov', '.mp3', '.wav', '.ogg', '.flac', '.glb', '.gltf', '.obj', '.fbx', '.stl', '.usdz', '.json', '.txt', '.md',
]);
const SECRET_FIELD = /(?:api[_-]?key|authorization|cookie|password|passwd|passphrase|private[_-]?key|client[_-]?secret|app[_-]?secret|secret[_-]?key|secret[_-]?access[_-]?key|access[_-]?key[_-]?secret|credential|access[_-]?token|refresh[_-]?token|id[_-]?token|session[_-]?token|signature|signed[_-]?token)$/i;
const SECRET_QUERY_FIELD = /^(?:api[_-]?key|key|token|access[_-]?token|refresh[_-]?token|signature|sig|x-amz-signature|x-goog-signature)$/i;
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object' && !Buffer.isBuffer(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function containsPlaintextSecret(value, seen = new Set()) {
  if (!value || typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_FIELD.test(key) && typeof child === 'string' && child.trim() && !/^\*{3,}$/.test(child.trim())) return true;
    if (typeof child === 'string' && /^https?:\/\//i.test(child.trim())) {
      try {
        const url = new URL(child);
        if (url.username || url.password || [...url.searchParams.keys()].some((name) => SECRET_QUERY_FIELD.test(name))) return true;
        if (/(?:^|[&#])(?:token|signature|sig|api[_-]?key)=/i.test(url.hash)) return true;
      } catch (_) {
        if (/[?&#](?:token|signature|sig|api[_-]?key)=/i.test(child)) return true;
      }
    }
    if (containsPlaintextSecret(child, seen)) return true;
  }
  return false;
}

function isZipMagic(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return false;
  const signature = buffer.subarray(0, 4).toString('hex');
  return signature === '504b0304' || signature === '504b0506' || signature === '504b0708';
}

function validateEntryPath(input, limits) {
  const name = String(input || '');
  if (!name || name.length > limits.pathLength || name.includes('\0')) throw new Error('t8flow 包含无效路径');
  if (name.includes('\\') || name.startsWith('/') || name.startsWith('//') || /^[a-zA-Z]:/.test(name)) throw new Error(`t8flow 禁止绝对或反斜杠路径: ${name}`);
  const isDirectory = name.endsWith('/');
  const withoutSlash = isDirectory ? name.slice(0, -1) : name;
  const parts = withoutSlash.split('/');
  if (parts.length > limits.pathDepth || parts.some((part) => !part || part === '.' || part === '..')) throw new Error(`t8flow 路径层级或片段无效: ${name}`);
  if (parts.some((part) => part.includes(':') || /[. ]$/.test(part) || WINDOWS_RESERVED.test(part))) throw new Error(`t8flow 包含 Windows 不安全路径: ${name}`);
  const normalized = path.posix.normalize(withoutSlash);
  if (normalized !== withoutSlash || normalized.startsWith('../')) throw new Error(`t8flow 路径穿越被拒绝: ${name}`);
  return { name: withoutSlash, isDirectory, normalizedKey: normalized.toLowerCase() };
}

function validateAllowedPath(name, isDirectory) {
  if (isDirectory) return;
  const extension = path.posix.extname(name).toLowerCase();
  if (BLOCKED_EXTENSIONS.has(extension)) throw new Error(`t8flow 禁止可执行或脚本文件: ${name}`);
  if (name === 'manifest.json' || name === 'definition.json') return;
  if (name.startsWith('dependencies/') && extension === '.json') return;
  if (name.startsWith('licenses/') && (extension === '.txt' || extension === '.md')) return;
  if (name.startsWith('assets/') && ASSET_EXTENSIONS.has(extension)) return;
  throw new Error(`t8flow 不允许的文件: ${name}`);
}

function openZip(buffer) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true, decodeStrings: true, validateEntrySizes: true }, (error, zipfile) => {
      if (error) reject(error);
      else resolve(zipfile);
    });
  });
}

function readEntry(zipfile, entry, maxBytes) {
  return new Promise((resolve, reject) => {
    zipfile.openReadStream(entry, (error, stream) => {
      if (error) return reject(error);
      const chunks = [];
      let total = 0;
      stream.on('data', (chunk) => {
        total += chunk.length;
        if (total > maxBytes) stream.destroy(new Error(`t8flow 条目超过上限: ${entry.fileName}`));
        else chunks.push(chunk);
      });
      stream.once('error', reject);
      stream.once('end', () => resolve(Buffer.concat(chunks)));
    });
  });
}

async function readArchiveEntries(buffer, customLimits = {}) {
  const limits = { ...DEFAULT_LIMITS, ...customLimits };
  if (!isZipMagic(buffer)) throw new Error('不是有效的 t8flow ZIP 包');
  if (buffer.length > limits.archiveBytes) throw new Error(`t8flow 归档超过 ${limits.archiveBytes} 字节`);
  const zipfile = await openZip(buffer);
  const files = new Map();
  const normalizedPaths = new Set();
  let entryCount = 0;
  let totalBytes = 0;
  try {
    await new Promise((resolve, reject) => {
      zipfile.once('error', reject);
      zipfile.once('end', resolve);
      zipfile.on('entry', async (entry) => {
        try {
          entryCount += 1;
          if (entryCount > limits.entryCount) throw new Error(`t8flow 条目超过 ${limits.entryCount} 个`);
          if ((entry.generalPurposeBitFlag & 0x1) !== 0) throw new Error(`t8flow 不允许加密条目: ${entry.fileName}`);
          const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
          if ((unixMode & 0xf000) === 0xa000) throw new Error(`t8flow 不允许符号链接: ${entry.fileName}`);
          const safePath = validateEntryPath(entry.fileName, limits);
          if (normalizedPaths.has(safePath.normalizedKey)) throw new Error(`t8flow 路径重复或大小写冲突: ${entry.fileName}`);
          normalizedPaths.add(safePath.normalizedKey);
          validateAllowedPath(safePath.name, safePath.isDirectory);
          if (safePath.isDirectory) {
            zipfile.readEntry();
            return;
          }
          if (entry.uncompressedSize > limits.entryBytes) throw new Error(`t8flow 条目过大: ${entry.fileName}`);
          const ratio = entry.uncompressedSize / Math.max(1, entry.compressedSize);
          if (ratio > limits.compressionRatio) throw new Error(`t8flow 压缩比异常: ${entry.fileName}`);
          totalBytes += entry.uncompressedSize;
          if (totalBytes > limits.totalBytes) throw new Error(`t8flow 解压总量超过 ${limits.totalBytes} 字节`);
          const content = await readEntry(zipfile, entry, limits.entryBytes);
          if (content.length !== entry.uncompressedSize) throw new Error(`t8flow 条目大小校验失败: ${entry.fileName}`);
          files.set(safePath.name, content);
          zipfile.readEntry();
        } catch (error) {
          reject(error);
          try { zipfile.close(); } catch (_) {}
        }
      });
      zipfile.readEntry();
    });
  } finally {
    try { zipfile.close(); } catch (_) {}
  }
  return { files, limits, entryCount, totalBytes };
}

function validateJsonStructure(value, limits = DEFAULT_LIMITS, label = 'JSON') {
  const stack = [{ value, depth: 0 }];
  let nodeCount = 0;
  let keyCount = 0;
  while (stack.length) {
    const current = stack.pop();
    nodeCount += 1;
    if (nodeCount > limits.jsonNodes) throw new Error(`t8flow ${label} 结构节点过多`);
    if (current.depth > limits.jsonDepth) throw new Error(`t8flow ${label} 嵌套层级超过 ${limits.jsonDepth}`);
    const item = current.value;
    if (typeof item === 'string' && Buffer.byteLength(item, 'utf8') > limits.jsonStringBytes) throw new Error(`t8flow ${label} 字符串过长`);
    if (typeof item === 'number' && !Number.isFinite(item)) throw new Error(`t8flow ${label} 包含无效数字`);
    if (!item || typeof item !== 'object') continue;
    if (Array.isArray(item)) {
      if (item.length > limits.jsonArrayLength) throw new Error(`t8flow ${label} 数组过长`);
      for (const child of item) stack.push({ value: child, depth: current.depth + 1 });
      continue;
    }
    const entries = Object.entries(item);
    keyCount += entries.length;
    if (keyCount > limits.jsonKeys) throw new Error(`t8flow ${label} 键数量过多`);
    for (const [key, child] of entries) {
      if (key === '__proto__' || key === 'prototype' || key === 'constructor') throw new Error(`t8flow ${label} 包含危险字段: ${key}`);
      if (Buffer.byteLength(key, 'utf8') > 512) throw new Error(`t8flow ${label} 字段名过长`);
      stack.push({ value: child, depth: current.depth + 1 });
    }
  }
  return value;
}

function validateDefinitionShape(definition, limits, label = '子工作流定义') {
  if (!definition || typeof definition !== 'object' || Array.isArray(definition)) throw new Error(`t8flow ${label}无效`);
  for (const [key, maximum] of [
    ['nodes', limits.definitionNodes], ['edges', limits.definitionEdges], ['inputs', limits.definitionPorts],
    ['outputs', limits.definitionPorts], ['exposedParameters', limits.definitionParameters],
  ]) {
    if (!Array.isArray(definition[key])) throw new Error(`t8flow ${label}缺少 ${key}`);
    if (definition[key].length > maximum) throw new Error(`t8flow ${label}的 ${key} 超过 ${maximum} 项`);
  }
  if ((definition.dependencies || []).length > limits.dependencyCount) throw new Error(`t8flow ${label}依赖超过 ${limits.dependencyCount} 项`);
  return definition;
}

function parseJsonFile(files, filename, maxBytes, limits = DEFAULT_LIMITS) {
  const content = files.get(filename);
  if (!content) throw new Error(`t8flow 缺少 ${filename}`);
  if (content.length > maxBytes) throw new Error(`t8flow ${filename} 过大`);
  try {
    return validateJsonStructure(JSON.parse(content.toString('utf8')), limits, filename);
  } catch (_) {
    throw new Error(`t8flow ${filename} JSON 无效`);
  }
}

function validateManifest(manifest, files) {
  if (!manifest || manifest.schema !== PACKAGE_SCHEMA || Number(manifest.version) !== PACKAGE_VERSION) throw new Error('t8flow manifest 版本不受支持');
  if (manifest.definition !== 'definition.json') throw new Error('t8flow definition 路径必须是 definition.json');
  if (!Array.isArray(manifest.files) || manifest.files.length > DEFAULT_LIMITS.entryCount) throw new Error('t8flow manifest 文件清单无效');
  const declared = new Map();
  for (const item of manifest.files) {
    const filename = String(item?.path || '');
    if (!filename || filename === 'manifest.json' || declared.has(filename)) throw new Error(`t8flow manifest 路径重复或无效: ${filename}`);
    const content = files.get(filename);
    if (!content) throw new Error(`t8flow manifest 声明文件不存在: ${filename}`);
    if (Number(item.size) !== content.length || String(item.sha256 || '').toLowerCase() !== sha256(content)) throw new Error(`t8flow 文件哈希或大小不匹配: ${filename}`);
    if (filename.startsWith('assets/') && (!String(item.license || '').trim() || item.redistributable !== true)) {
      throw new Error(`t8flow 资产缺少可再分发许可: ${filename}`);
    }
    declared.set(filename, item);
  }
  for (const filename of files.keys()) {
    if (filename !== 'manifest.json' && !declared.has(filename)) throw new Error(`t8flow 包含未声明文件: ${filename}`);
  }
}

async function inspectSubflowPackage(buffer, options = {}) {
  const archiveSha256 = sha256(buffer);
  const { files, entryCount, totalBytes, limits } = await readArchiveEntries(buffer, options.limits);
  const manifest = parseJsonFile(files, 'manifest.json', limits.manifestBytes, limits);
  validateManifest(manifest, files);
  const definition = validateDefinitionShape(parseJsonFile(files, 'definition.json', limits.manifestBytes, limits), limits);
  if (containsPlaintextSecret(definition)) throw new Error('t8flow 子工作流定义包含明文凭据');
  const dependencyEntries = manifest.files.filter((item) => item?.kind === 'dependency');
  if (dependencyEntries.length > limits.dependencyCount) throw new Error(`t8flow 嵌套依赖超过 ${limits.dependencyCount} 项`);
  const dependencies = dependencyEntries.map((item) => {
    const dependency = validateDefinitionShape(parseJsonFile(files, String(item.path), limits.manifestBytes, limits), limits, `嵌套依赖 ${String(item.path)} `);
    if (containsPlaintextSecret(dependency)) throw new Error(`t8flow 嵌套依赖包含明文凭据: ${String(item.path)}`);
    if (String(item.definitionId || '') !== String(dependency.id || '') || Number(item.definitionVersion) !== Number(dependency.version)) throw new Error(`t8flow 嵌套依赖身份不匹配: ${String(item.path)}`);
    return dependency;
  });
  return {
    archiveSha256,
    manifest,
    definition,
    dependencies,
    entryCount,
    totalBytes,
    files: [...files.entries()].filter(([name]) => name !== 'manifest.json').map(([name, content]) => ({ path: name, size: content.length, sha256: sha256(content) })),
  };
}

async function importSubflowPackage(buffer, options = {}) {
  const actualHash = sha256(buffer);
  if (options.expectedArchiveSha256 && String(options.expectedArchiveSha256).toLowerCase() !== actualHash) {
    throw new Error('t8flow 归档在检查后发生变化');
  }
  const inspected = await inspectSubflowPackage(buffer, options);
  const { files } = await readArchiveEntries(buffer, options.limits);
  const assets = inspected.manifest.files.filter((item) => item?.kind === 'asset').map((item) => ({
    path: String(item.path),
    assetRef: String(item.assetRef || item.path),
    license: String(item.license || ''),
    redistributable: item.redistributable === true,
    content: Buffer.from(files.get(String(item.path)) || []),
    sha256: String(item.sha256 || ''),
  }));
  return {
    ...inspected,
    assets,
    definition: {
      ...inspected.definition,
      projectId: String(options.projectId || inspected.definition.projectId || 'project-local'),
      id: options.preserveId === false ? undefined : inspected.definition.id,
      version: options.preserveVersion === false ? undefined : inspected.definition.version,
    },
  };
}

function collectZip(zipfile) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    zipfile.outputStream.on('data', (chunk) => chunks.push(chunk));
    zipfile.outputStream.once('error', reject);
    zipfile.outputStream.once('end', () => resolve(Buffer.concat(chunks)));
    zipfile.end({ forceZip64Format: false });
  });
}

function dependencyPackagePath(definition) {
  const identity = `${String(definition?.projectId || 'project-local')}:${String(definition?.id || '')}:${Math.max(1, Number(definition?.version) || 1)}`;
  return `dependencies/${sha256(identity).slice(0, 24)}.json`;
}

function hydrateDependencyDefinitions(definition, dependencies = [], options = {}) {
  const targetProjectId = String(options.projectId || definition.projectId || 'project-local');
  const index = new Map();
  for (const item of dependencies) {
    const key = `${String(item.id)}:${Number(item.version)}`;
    if (index.has(key)) throw new Error(`t8flow 包含冲突的嵌套依赖: ${key}`);
    index.set(key, item);
  }
  const visit = (current, stack = []) => ({
    ...current,
    projectId: targetProjectId,
    nodes: (current.nodes || []).map((node) => {
      if (node.type !== 'subflow') return node;
      const data = node.data && typeof node.data === 'object' ? node.data : {};
      const embedded = data.definition && typeof data.definition === 'object' ? data.definition : null;
      const id = String(data.definitionId || embedded?.id || '');
      const version = Number(data.definitionVersion || embedded?.version || 0);
      const key = `${id}:${version}`;
      if (!id || !version) throw new Error(`t8flow 嵌套节点缺少固定定义身份: ${String(node.id || '')}`);
      if (stack.includes(key)) throw new Error(`t8flow 嵌套依赖循环: ${[...stack, key].join(' -> ')}`);
      const dependency = index.get(key) || embedded;
      if (!dependency) throw new Error(`t8flow 缺少嵌套依赖: ${key}`);
      return { ...node, data: { ...data, definitionId: id, definitionVersion: version, definitionProjectId: targetProjectId, definition: visit(dependency, [...stack, key]) } };
    }),
  });
  return visit(definition);
}

async function createSubflowPackage(definition, assets = [], dependencies = []) {
  if (!definition || typeof definition !== 'object') throw new Error('子工作流定义无效');
  validateJsonStructure(definition, DEFAULT_LIMITS, '子工作流定义');
  validateDefinitionShape(definition, DEFAULT_LIMITS);
  if (containsPlaintextSecret(definition)) throw new Error('子工作流定义包含明文凭据');
  const entries = [{ path: 'definition.json', content: Buffer.from(`${stableJson(definition)}\n`, 'utf8'), kind: 'definition' }];
  const dependencyKeys = new Set();
  if (dependencies.length > DEFAULT_LIMITS.dependencyCount) throw new Error(`嵌套子工作流依赖超过 ${DEFAULT_LIMITS.dependencyCount} 项`);
  for (const dependency of dependencies) {
    if (!dependency || typeof dependency !== 'object' || !dependency.id || !dependency.version) throw new Error('嵌套子工作流依赖无效');
    validateJsonStructure(dependency, DEFAULT_LIMITS, `嵌套依赖 ${String(dependency.id)}`);
    validateDefinitionShape(dependency, DEFAULT_LIMITS, `嵌套依赖 ${String(dependency.id)} `);
    if (containsPlaintextSecret(dependency)) throw new Error(`嵌套子工作流依赖包含明文凭据: ${String(dependency.id)}`);
    const identity = `${String(dependency.projectId || definition.projectId || 'project-local')}:${String(dependency.id)}:${Number(dependency.version)}`;
    if (dependencyKeys.has(identity)) continue;
    dependencyKeys.add(identity);
    entries.push({ path: dependencyPackagePath(dependency), content: Buffer.from(`${stableJson(dependency)}\n`, 'utf8'), kind: 'dependency', definitionId: String(dependency.id), definitionVersion: Number(dependency.version), projectId: String(dependency.projectId || definition.projectId || 'project-local') });
  }
  for (const asset of assets) {
    const filename = String(asset?.path || '');
    const safePath = validateEntryPath(filename, DEFAULT_LIMITS);
    validateAllowedPath(safePath.name, false);
    if (!safePath.name.startsWith('assets/')) throw new Error(`资产必须位于 assets/: ${filename}`);
    if (!String(asset.license || '').trim() || asset.redistributable !== true) throw new Error(`资产缺少可再分发许可: ${filename}`);
    entries.push({ ...asset, path: safePath.name, assetRef: String(asset.assetRef || safePath.name), content: Buffer.from(asset.content) });
  }
  entries.sort((left, right) => left.path.localeCompare(right.path));
  const manifest = {
    schema: PACKAGE_SCHEMA,
    version: PACKAGE_VERSION,
    definition: 'definition.json',
    definitionId: String(definition.id || ''),
    definitionVersion: Math.max(1, Number(definition.version) || 1),
    files: entries.map((entry) => ({
      path: entry.path,
      size: entry.content.length,
      sha256: sha256(entry.content),
      kind: entry.kind || 'asset',
      ...(entry.path.startsWith('assets/') ? { license: String(entry.license), redistributable: true } : {}),
      ...(entry.path.startsWith('assets/') ? { assetRef: String(entry.assetRef || entry.path) } : {}),
      ...(entry.kind === 'dependency' ? { definitionId: entry.definitionId, definitionVersion: entry.definitionVersion, projectId: entry.projectId } : {}),
    })),
  };
  const zipfile = new yazl.ZipFile();
  zipfile.addBuffer(Buffer.from(`${stableJson(manifest)}\n`, 'utf8'), 'manifest.json', { mtime: FIXED_ZIP_TIME, mode: 0o100644, compress: true });
  for (const entry of entries) zipfile.addBuffer(entry.content, entry.path, { mtime: FIXED_ZIP_TIME, mode: 0o100644, compress: true });
  return collectZip(zipfile);
}

module.exports = {
  PACKAGE_SCHEMA,
  PACKAGE_VERSION,
  DEFAULT_LIMITS,
  validateJsonStructure,
  containsPlaintextSecret,
  inspectSubflowPackage,
  importSubflowPackage,
  createSubflowPackage,
  hydrateDependencyDefinitions,
  sha256,
};
