'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { getRecipeSigningSecret } = require('./secureStore.cjs');

const RECIPE_STORE_SCHEMA = 't8-zcanvas-creator-recipes-v1';
const RECIPE_SCHEMA = 't8-creator-recipe-v1';
const RECIPE_EXPORT_SCHEMA = 't8-creator-recipe-export-v1';
const RECIPE_STORE_LIMIT = 2 * 1024 * 1024;
const RECIPE_FILE_LIMIT = 256 * 1024;
const LOCK_KEYS = new Set([
  'identity', 'wardrobe', 'background', 'prompt',
  'productShape', 'logo', 'composition', 'scene',
]);
const KINDS = new Set(['image', 'edit-image', 'video', 'edit-video', 'audio', 'script', 'story']);
const PROFILES = new Set(['economy', 'balanced', 'quality', 'custom']);

class RecipeStoreError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'RecipeStoreError';
    this.code = code;
    this.details = details;
  }
}

function stableString(value) {
  if (value === undefined || value === null) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableString).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableString(value[key])}`).join(',')}}`;
}

function sha256(value) {
  return crypto.createHash('sha256').update(
    typeof value === 'string' || Buffer.isBuffer(value) ? value : stableString(value),
  ).digest('hex');
}

function cleanText(value, maximum) {
  const normalized = String(value ?? '').normalize('NFKC').replace(/\u0000/g, '').trim();
  if (normalized.length > maximum) {
    throw new RecipeStoreError('RECIPE_FIELD_TOO_LONG', `项目配方字段超过 ${maximum} 个字符`);
  }
  return normalized;
}

function identifier(value, label) {
  const normalized = cleanText(value, 80).toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,79}$/.test(normalized)) {
    throw new RecipeStoreError('RECIPE_ID_INVALID', `${label} 只能包含小写字母、数字、点、下划线或短横线`);
  }
  return normalized;
}

function projectIdentifier(value) {
  const normalized = cleanText(value, 160);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(normalized)) {
    throw new RecipeStoreError('RECIPE_PROJECT_INVALID', '项目 ID 无效');
  }
  return normalized;
}

function boundedStringArray(value, maximumItems, maximumLength) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.slice(0, maximumItems)
    .map((item) => cleanText(typeof item === 'string' ? item : item?.name || item?.label || '', maximumLength))
    .filter(Boolean))];
}

function normalizeDefinition(value, name) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const defaults = source.defaults && typeof source.defaults === 'object' && !Array.isArray(source.defaults)
    ? source.defaults
    : {};
  const guidance = source.guidance && typeof source.guidance === 'object' && !Array.isArray(source.guidance)
    ? source.guidance
    : {};
  const kind = cleanText(source.kind, 40).toLowerCase();
  const profile = cleanText(defaults.profile, 40).toLowerCase();
  const duration = defaults.duration == null || defaults.duration === ''
    ? undefined
    : Number(defaults.duration);
  if (kind && !KINDS.has(kind)) {
    throw new RecipeStoreError('RECIPE_KIND_INVALID', '项目配方 kind 不受支持');
  }
  if (profile && !PROFILES.has(profile)) {
    throw new RecipeStoreError('RECIPE_PROFILE_INVALID', '项目配方 profile 不受支持');
  }
  if (duration != null && (!Number.isFinite(duration) || duration < 0 || duration > 86_400)) {
    throw new RecipeStoreError('RECIPE_DURATION_INVALID', '项目配方 duration 必须在 0 到 86400 秒之间');
  }
  const locks = boundedStringArray(defaults.locks, 16, 40);
  if (locks.some((lock) => !LOCK_KEYS.has(lock))) {
    throw new RecipeStoreError('RECIPE_LOCK_INVALID', '项目配方包含未知连续性锁');
  }
  const stringDefaults = {};
  for (const [key, maximum] of Object.entries({
    ratio: 20,
    format: 200,
    style: 2_000,
    template: 80,
    llmProvider: 160,
    llmModel: 240,
    imageProvider: 160,
    imageModel: 240,
    videoProvider: 160,
    videoModel: 240,
    audioProvider: 160,
    audioModel: 240,
  })) {
    const normalized = cleanText(defaults[key], maximum);
    if (normalized) stringDefaults[key] = normalized;
  }
  const normalizedGuidance = {};
  for (const key of ['directorStyle', 'characterBible', 'productBible', 'shotGrammar', 'negativeRules']) {
    const normalized = cleanText(guidance[key], 4_000);
    if (normalized) normalizedGuidance[key] = normalized;
  }
  return {
    schema: RECIPE_SCHEMA,
    id: identifier(name || source.id || source.name, '配方名称'),
    label: cleanText(source.label, 120) || identifier(name || source.id || source.name, '配方名称'),
    ...(kind ? { kind } : {}),
    defaults: {
      ...stringDefaults,
      ...(duration == null ? {} : { duration: Math.round(duration) }),
      ...(profile ? { profile } : {}),
      ...(locks.length ? { locks } : {}),
    },
    guidance: normalizedGuidance,
    stages: boundedStringArray(source.stages, 24, 160),
    reviewDimensions: boundedStringArray(source.reviewDimensions, 24, 160),
    compatibility: {
      minimumDesktopVersion: cleanText(source.compatibility?.minimumDesktopVersion, 40) || '2.6.4',
      maximumDesktopVersion: cleanText(source.compatibility?.maximumDesktopVersion, 40),
    },
  };
}

function recipeStorePath(options = {}) {
  const explicit = cleanText(options.env?.ZCANVAS_RECIPE_STORE || process.env.ZCANVAS_RECIPE_STORE, 1024);
  if (explicit) return path.resolve(explicit);
  return path.join(options.homeDir || os.homedir(), '.zcanvas', 'creator-recipes-v1.json');
}

function emptyStore() {
  return { schema: RECIPE_STORE_SCHEMA, projects: {} };
}

function readStore(options = {}) {
  const filename = recipeStorePath(options);
  try {
    const stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > RECIPE_STORE_LIMIT) {
      throw new RecipeStoreError('RECIPE_STORE_INVALID', '项目配方存储无效');
    }
    const parsed = JSON.parse(fs.readFileSync(filename, 'utf8'));
    if (parsed?.schema !== RECIPE_STORE_SCHEMA
      || !parsed.projects || typeof parsed.projects !== 'object' || Array.isArray(parsed.projects)) {
      throw new RecipeStoreError('RECIPE_STORE_INVALID', '项目配方存储格式不兼容');
    }
    return parsed;
  } catch (error) {
    if (error?.code === 'ENOENT') return emptyStore();
    if (error instanceof RecipeStoreError) throw error;
    throw new RecipeStoreError('RECIPE_STORE_INVALID', '无法读取项目配方存储');
  }
}

function writeStore(store, options = {}) {
  const filename = recipeStorePath(options);
  const directory = path.dirname(filename);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const serialized = `${JSON.stringify(store, null, 2)}\n`;
  if (Buffer.byteLength(serialized) > RECIPE_STORE_LIMIT) {
    throw new RecipeStoreError('RECIPE_STORE_FULL', '项目配方存储超过安全上限');
  }
  const temp = `${filename}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temp, serialized, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    fs.renameSync(temp, filename);
    try { fs.chmodSync(filename, 0o600); } catch (_) {}
  } finally {
    try { fs.rmSync(temp, { force: true }); } catch (_) {}
  }
}

function signingIdentity(options = {}) {
  if (options.signingSecret) {
    const secret = String(options.signingSecret);
    return { secret, keyId: sha256(secret).slice(0, 20) };
  }
  return getRecipeSigningSecret(options.secureStoreOptions || options);
}

function signedPayload(record) {
  return {
    projectId: record.projectId,
    name: record.name,
    version: record.version,
    createdAt: record.createdAt,
    contentDigest: record.contentDigest,
    definition: record.definition,
  };
}

function signatureFor(record, secret) {
  return crypto.createHmac('sha256', secret).update(stableString(signedPayload(record))).digest('hex');
}

function verifyRecord(record, options = {}) {
  const identity = signingIdentity(options);
  const actualDigest = sha256(record?.definition);
  const expectedSignature = signatureFor(record || {}, identity.secret);
  const digestValid = actualDigest === record?.contentDigest;
  const signatureValid = record?.signature?.algorithm === 'hmac-sha256'
    && record.signature.keyId === identity.keyId
    && typeof record.signature.value === 'string'
    && crypto.timingSafeEqual(
      Buffer.from(expectedSignature, 'utf8'),
      Buffer.from(String(record.signature.value || '').padEnd(64, '0').slice(0, 64), 'utf8'),
    );
  return {
    valid: digestValid && signatureValid,
    digestValid,
    signatureValid,
    contentDigest: actualDigest,
    keyId: identity.keyId,
  };
}

function projectRecipes(store, projectId, create = false) {
  const key = projectIdentifier(projectId);
  if (!store.projects[key] && create) store.projects[key] = { recipes: {} };
  const project = store.projects[key];
  if (!project) return null;
  if (!project.recipes || typeof project.recipes !== 'object' || Array.isArray(project.recipes)) {
    throw new RecipeStoreError('RECIPE_STORE_INVALID', '项目配方索引损坏');
  }
  return project.recipes;
}

function saveRecipe(projectId, name, definition, options = {}) {
  const store = readStore(options);
  const projectKey = projectIdentifier(projectId);
  const recipeName = identifier(name || definition?.id || definition?.name, '配方名称');
  const recipes = projectRecipes(store, projectKey, true);
  const current = recipes[recipeName] || { pinnedVersion: 0, versions: [] };
  const versions = Array.isArray(current.versions) ? current.versions : [];
  const version = versions.reduce((maximum, item) => Math.max(maximum, Number(item?.version) || 0), 0) + 1;
  const normalized = normalizeDefinition(definition, recipeName);
  const identity = signingIdentity(options);
  const record = {
    projectId: projectKey,
    name: recipeName,
    version,
    createdAt: typeof options.now === 'function' ? options.now() : new Date().toISOString(),
    contentDigest: sha256(normalized),
    definition: normalized,
  };
  record.signature = {
    algorithm: 'hmac-sha256',
    keyId: identity.keyId,
    value: signatureFor(record, identity.secret),
  };
  recipes[recipeName] = {
    pinnedVersion: version,
    versions: [...versions, record].slice(-32),
  };
  writeStore(store, options);
  return { ...record, pinned: true, verified: true };
}

function findRecipe(projectId, name, version, options = {}) {
  const store = readStore(options);
  const recipeName = identifier(name, '配方名称');
  const recipes = projectRecipes(store, projectId, false);
  const entry = recipes?.[recipeName];
  if (!entry || !Array.isArray(entry.versions) || !entry.versions.length) {
    throw new RecipeStoreError('RECIPE_NOT_FOUND', `项目中不存在配方 ${recipeName}`);
  }
  const wanted = version == null || version === ''
    ? Number(entry.pinnedVersion) || Math.max(...entry.versions.map((item) => Number(item.version) || 0))
    : Number(version);
  const record = entry.versions.find((item) => Number(item.version) === wanted);
  if (!record) throw new RecipeStoreError('RECIPE_VERSION_NOT_FOUND', `配方 ${recipeName} 不存在版本 ${wanted}`);
  const verification = verifyRecord(record, options);
  if (!verification.valid) {
    throw new RecipeStoreError('RECIPE_SIGNATURE_INVALID', '项目配方摘要或本机签名校验失败', verification);
  }
  return {
    ...record,
    pinned: Number(entry.pinnedVersion) === Number(record.version),
    verified: true,
  };
}

function listRecipes(projectId, options = {}) {
  const store = readStore(options);
  const recipes = projectRecipes(store, projectId, false) || {};
  return Object.entries(recipes).sort(([left], [right]) => left.localeCompare(right)).map(([name, entry]) => {
    const latestVersion = Math.max(0, ...(entry.versions || []).map((item) => Number(item.version) || 0));
    const pinnedVersion = Number(entry.pinnedVersion) || latestVersion;
    const record = (entry.versions || []).find((item) => Number(item.version) === pinnedVersion);
    const verification = record ? verifyRecord(record, options) : { valid: false };
    return {
      name,
      label: record?.definition?.label || name,
      kind: record?.definition?.kind || '',
      pinnedVersion,
      latestVersion,
      versions: Array.isArray(entry.versions) ? entry.versions.length : 0,
      verified: verification.valid,
      contentDigest: record?.contentDigest || '',
    };
  });
}

function pinRecipe(projectId, name, version, options = {}) {
  const verified = findRecipe(projectId, name, version, options);
  const store = readStore(options);
  const recipes = projectRecipes(store, projectId, false);
  recipes[verified.name].pinnedVersion = verified.version;
  writeStore(store, options);
  return { ...verified, pinned: true };
}

function rollbackRecipe(projectId, name, options = {}) {
  const store = readStore(options);
  const recipeName = identifier(name, '配方名称');
  const recipes = projectRecipes(store, projectId, false);
  const entry = recipes?.[recipeName];
  if (!entry || !Array.isArray(entry.versions) || entry.versions.length < 2) {
    throw new RecipeStoreError('RECIPE_ROLLBACK_UNAVAILABLE', '项目配方没有可回滚的历史版本');
  }
  const current = Number(entry.pinnedVersion)
    || Math.max(...entry.versions.map((item) => Number(item.version) || 0));
  const previous = entry.versions
    .map((item) => Number(item.version) || 0)
    .filter((version) => version < current)
    .sort((left, right) => right - left)[0];
  if (!previous) throw new RecipeStoreError('RECIPE_ROLLBACK_UNAVAILABLE', '项目配方没有更早的可用版本');
  return pinRecipe(projectId, recipeName, previous, options);
}

function readRecipeFile(filename) {
  const requested = cleanText(filename, 1024);
  if (!path.isAbsolute(requested)) {
    throw new RecipeStoreError('RECIPE_FILE_PATH_INVALID', '项目配方文件必须使用绝对路径');
  }
  const resolved = path.resolve(requested);
  let stat;
  try {
    stat = fs.lstatSync(resolved);
  } catch (_) {
    throw new RecipeStoreError('RECIPE_FILE_NOT_FOUND', '找不到项目配方文件');
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > RECIPE_FILE_LIMIT) {
    throw new RecipeStoreError('RECIPE_FILE_INVALID', '项目配方必须是 1-256 KiB 的普通 JSON 文件');
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(resolved, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('shape');
    return parsed;
  } catch (_) {
    throw new RecipeStoreError('RECIPE_FILE_INVALID', '项目配方文件不是有效 JSON 对象');
  }
}

function exportRecipe(projectId, name, filename, options = {}) {
  const record = findRecipe(projectId, name, options.version, options);
  const requested = cleanText(filename, 1024);
  if (!path.isAbsolute(requested)) {
    throw new RecipeStoreError('RECIPE_FILE_PATH_INVALID', '项目配方导出必须使用绝对路径');
  }
  const resolved = path.resolve(requested);
  const payload = {
    schema: RECIPE_EXPORT_SCHEMA,
    exportedAt: typeof options.now === 'function' ? options.now() : new Date().toISOString(),
    record,
  };
  fs.mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 });
  fs.writeFileSync(resolved, `${JSON.stringify(payload, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: options.overwrite === true ? 'w' : 'wx',
  });
  return { path: resolved, name: record.name, version: record.version, contentDigest: record.contentDigest };
}

function importRecipe(projectId, filename, options = {}) {
  const parsed = readRecipeFile(filename);
  const rawRecord = parsed.schema === RECIPE_EXPORT_SCHEMA ? parsed.record : null;
  const rawDefinition = rawRecord?.definition || parsed;
  const name = identifier(options.name || rawRecord?.name || rawDefinition?.id || rawDefinition?.name, '配方名称');
  if (rawRecord?.contentDigest && sha256(rawDefinition) !== rawRecord.contentDigest) {
    throw new RecipeStoreError('RECIPE_IMPORT_DIGEST_INVALID', '导入配方的内容摘要不匹配');
  }
  let sourceSignatureVerified = false;
  if (rawRecord?.signature) {
    try {
      sourceSignatureVerified = verifyRecord(rawRecord, options).valid;
    } catch (_) {
      sourceSignatureVerified = false;
    }
  }
  const saved = saveRecipe(projectId, name, rawDefinition, options);
  return {
    ...saved,
    imported: true,
    sourceSignatureVerified,
    trust: sourceSignatureVerified ? 'same-signing-identity' : 'explicit-user-import-content-digest',
  };
}

function verifyProjectRecipes(projectId, options = {}) {
  const store = readStore(options);
  const recipes = projectRecipes(store, projectId, false) || {};
  const records = [];
  for (const [name, entry] of Object.entries(recipes)) {
    for (const record of entry.versions || []) {
      records.push({ name, version: record.version, ...verifyRecord(record, options) });
    }
  }
  return {
    valid: records.every((item) => item.valid),
    total: records.length,
    records,
  };
}

module.exports = {
  RECIPE_EXPORT_SCHEMA,
  RECIPE_SCHEMA,
  RECIPE_STORE_SCHEMA,
  RecipeStoreError,
  exportRecipe,
  findRecipe,
  importRecipe,
  listRecipes,
  normalizeDefinition,
  pinRecipe,
  readRecipeFile,
  recipeStorePath,
  rollbackRecipe,
  saveRecipe,
  sha256,
  verifyProjectRecipes,
  verifyRecord,
};
