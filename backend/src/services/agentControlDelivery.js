'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const { openVerifiedAssetMedia } = require('./assetAvailability');
const { sanitizePublicValue } = require('./assetPublicView');

const DELIVERY_SCHEMA = 't8-agent-delivery-manifest-v1';
const LICENSE_SCHEMA = 't8-agent-delivery-licenses-v1';
const MAX_DELIVERY_ASSETS = 500;
const MAX_MANIFEST_BYTES = 5 * 1024 * 1024;
const MAX_PACKAGE_ENTRIES = (MAX_DELIVERY_ASSETS * 8) + 32;
const DELIVERY_MANIFEST_FILENAME = 'zcanvas-delivery-manifest.json';
const DELIVERY_LICENSES_FILENAME = 'zcanvas-delivery-licenses.json';
const ASSET_ID_KEY = /^(?:assetId|assetIds|sourceAssetId|sourceAssetIds|resultAssetId|resultAssetIds|outputAssetId|outputAssetIds|referenceAssetId|referenceAssetIds)$/i;
const MEDIA_ASSET_URL = /\/api\/project-assets\/([^/?#]+)\/media(?:[?#]|$)/gi;
const EXTENSION_BY_MIME = Object.freeze({
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/bmp': '.bmp',
  'image/avif': '.avif',
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'video/webm': '.webm',
  'video/x-m4v': '.m4v',
  'audio/mpeg': '.mp3',
  'audio/wav': '.wav',
  'audio/mp4': '.m4a',
  'audio/aac': '.aac',
  'audio/flac': '.flac',
  'audio/ogg': '.ogg',
  'model/gltf-binary': '.glb',
  'model/gltf+json': '.gltf',
  'model/obj': '.obj',
  'text/plain': '.txt',
  'text/markdown': '.md',
});

class AgentControlDeliveryError extends Error {
  constructor(code, message, status = 400, details = null) {
    super(message);
    this.name = 'AgentControlDeliveryError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function boundedText(value, limit = 240) {
  return String(value == null ? '' : value).trim().slice(0, limit);
}

function unique(values) {
  return [...new Set((Array.isArray(values) ? values : []).map((value) => boundedText(value, 240)).filter(Boolean))];
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function hashFile(filename) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const input = fs.createReadStream(filename);
    input.once('error', reject);
    input.on('data', (chunk) => hash.update(chunk));
    input.once('end', () => resolve(hash.digest('hex')));
  });
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function manifestDigest(manifest) {
  const copy = { ...manifest };
  delete copy.packageDigest;
  return sha256(stableJson(copy));
}

function extractAssetIds(document) {
  const ids = new Set();
  const storyLogicalIds = new Set();
  let visited = 0;
  const seen = new WeakSet();
  (Array.isArray(document?.nodes) ? document.nodes : []).forEach((node) => {
    const storyAssets = record(record(node?.data).storyProject).assets;
    if (!Array.isArray(storyAssets)) return;
    storyAssets.forEach((asset) => {
      const id = boundedText(record(asset).id, 240);
      if (id) storyLogicalIds.add(id);
    });
  });
  function add(value, key = '') {
    const id = boundedText(value, 240);
    if (id
      && !(String(key).toLowerCase() === 'assetids' && storyLogicalIds.has(id))
      && ids.size < MAX_DELIVERY_ASSETS * 2) ids.add(id);
  }
  function walk(value, key = '', depth = 0) {
    if (visited >= 20_000 || depth > 14 || value == null) return;
    visited += 1;
    if (typeof value === 'string') {
      if (ASSET_ID_KEY.test(key)) add(value, key);
      MEDIA_ASSET_URL.lastIndex = 0;
      let match;
      while ((match = MEDIA_ASSET_URL.exec(value))) {
        try { add(decodeURIComponent(match[1])); } catch (_) { add(match[1]); }
      }
      return;
    }
    if (typeof value !== 'object' || Buffer.isBuffer(value) || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      value.slice(0, 2_000).forEach((item) => walk(item, key, depth + 1));
    } else {
      Object.entries(value).slice(0, 2_000).forEach(([childKey, child]) => {
        if (ASSET_ID_KEY.test(childKey) && Array.isArray(child)) child.forEach((item) => add(item, childKey));
        else walk(child, childKey, depth + 1);
      });
    }
    seen.delete(value);
  }
  (Array.isArray(document?.nodes) ? document.nodes : []).slice(0, 5_000)
    .forEach((node) => walk(record(node?.data), 'data', 0));
  return [...ids];
}

function projectAssetIds(database, projectId) {
  const total = Math.max(0, Number(database.countAssets({ projectId })) || 0);
  if (total > MAX_DELIVERY_ASSETS) {
    throw new AgentControlDeliveryError(
      'DELIVERY_ASSET_LIMIT_EXCEEDED',
      `当前项目有 ${total} 个素材；一次最多交付 ${MAX_DELIVERY_ASSETS} 个，请使用 --asset 精确选择`,
      413,
      { total, limit: MAX_DELIVERY_ASSETS },
    );
  }
  return database.listAssets({
    projectId,
    limit: Math.max(1, Math.min(MAX_DELIVERY_ASSETS, total || 1)),
    offset: 0,
  }).map((asset) => String(asset.id || '')).filter(Boolean);
}

function licenseMetadata(asset) {
  const metadata = record(asset.metadata);
  const provenance = record(asset.provenance);
  const raw = record(metadata.license || provenance.license);
  const status = boundedText(
    metadata.licenseStatus || provenance.licenseStatus || raw.status,
    80,
  ).toLowerCase();
  return sanitizePublicValue({
    status: ['verified', 'owned', 'licensed', 'public-domain', 'unknown'].includes(status)
      ? status
      : 'unknown',
    name: boundedText(raw.name || metadata.licenseName || provenance.licenseName, 160) || null,
    source: boundedText(raw.source || metadata.licenseSource || provenance.licenseSource, 240) || null,
    note: boundedText(raw.note || metadata.licenseNote || provenance.licenseNote, 500)
      || '未找到可证明的许可信息；交付前需由创作者确认。',
  });
}

function renditionRole(asset) {
  const metadata = record(asset.metadata);
  const provenance = record(asset.provenance);
  const value = boundedText(
    metadata.deliveryRole
      || metadata.renditionRole
      || metadata.variant
      || provenance.deliveryRole
      || provenance.renditionRole,
    40,
  ).toLowerCase();
  return ['master', 'proxy', 'original'].includes(value) ? value : 'unknown';
}

function extensionFor(asset) {
  const source = boundedText(asset.filename || asset.name || record(asset.metadata).filename, 500);
  const extension = path.extname(source).toLowerCase();
  if (/^\.[a-z0-9]{1,10}$/.test(extension)) return extension;
  return EXTENSION_BY_MIME[String(asset.mimeType || '').toLowerCase()] || '.bin';
}

function safeLabel(asset) {
  const raw = boundedText(sanitizePublicValue(
    asset.title || asset.name || asset.filename || record(asset.metadata).title || asset.id,
  ), 120);
  const basename = path.posix.basename(path.win32.basename(raw));
  const withoutExtension = basename.replace(/\.[A-Za-z0-9]{1,10}$/, '');
  const cleaned = withoutExtension
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/[.-]+$/g, '')
    .slice(0, 60);
  return cleaned || 'asset';
}

function mediaFolder(kind) {
  return {
    image: 'images',
    video: 'videos',
    audio: 'audio',
    text: 'text',
    model3d: 'models',
  }[String(kind || '').toLowerCase()] || 'other';
}

function deliveryAssetView(asset, index) {
  const contentHash = boundedText(asset.contentHash, 64).toLowerCase();
  const role = renditionRole(asset);
  const root = role === 'master' || role === 'original'
    ? 'masters'
    : role === 'proxy' ? 'proxies' : 'media';
  const relativePath = path.posix.join(
    root,
    mediaFolder(asset.kind),
    `${String(index + 1).padStart(3, '0')}-${safeLabel(asset)}-${contentHash.slice(0, 8)}${extensionFor(asset)}`,
  );
  return {
    assetId: String(asset.id || ''),
    kind: boundedText(asset.kind, 40) || 'unknown',
    mimeType: boundedText(asset.mimeType, 120) || 'application/octet-stream',
    filename: path.posix.basename(relativePath),
    relativePath,
    size: Math.max(0, Number(asset.sizeBytes || asset.size || record(asset.metadata).size) || 0),
    sha256: contentHash,
    renditionRole: role,
    license: licenseMetadata(asset),
    createdAt: asset.createdAt == null ? null : String(asset.createdAt),
  };
}

function inspectPackageTarget(target) {
  const raw = String(target || '');
  if (!path.isAbsolute(raw)) {
    throw new AgentControlDeliveryError('DELIVERY_PATH_INVALID', '交付包必须使用绝对目标目录');
  }
  const absolute = path.resolve(raw);
  const basename = path.basename(absolute);
  if (!basename || absolute === path.parse(absolute).root) {
    throw new AgentControlDeliveryError('DELIVERY_PATH_INVALID', '交付包目标不能是磁盘根目录');
  }
  let current = path.dirname(absolute);
  while (current && current !== path.dirname(current)) {
    if (fs.existsSync(current)) {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) {
        throw new AgentControlDeliveryError('DELIVERY_PATH_SYMLINK', '交付包目标目录包含链接，已停止');
      }
      if (!stat.isDirectory()) {
        throw new AgentControlDeliveryError('DELIVERY_PARENT_INVALID', '交付包目标的上级不是文件夹');
      }
    }
    current = path.dirname(current);
  }
  if (fs.existsSync(absolute)) {
    throw new AgentControlDeliveryError('DELIVERY_TARGET_EXISTS', '交付包目标已存在，不会覆盖', 409);
  }
  return { absolute, basename };
}

function assertSafeRelativePath(root, relativePath) {
  const normalized = String(relativePath || '').replace(/\\/g, '/');
  if (!normalized
    || path.posix.isAbsolute(normalized)
    || normalized.split('/').includes('..')
    || normalized.includes('\u0000')) {
    throw new AgentControlDeliveryError('DELIVERY_MANIFEST_PATH_INVALID', '交付清单包含不安全路径', 409);
  }
  const absolute = path.resolve(root, ...normalized.split('/'));
  const prefix = `${path.resolve(root)}${path.sep}`;
  if (!absolute.startsWith(prefix)) {
    throw new AgentControlDeliveryError('DELIVERY_MANIFEST_PATH_INVALID', '交付清单路径越出交付目录', 409);
  }
  return absolute;
}

function canonicalManifestPath(root, relativePath) {
  const normalized = String(relativePath || '').replace(/\\/g, '/');
  const canonical = path.posix.normalize(normalized);
  if (canonical !== normalized
    || canonical === '.'
    || canonical.startsWith('./')
    || canonical.endsWith('/')) {
    throw new AgentControlDeliveryError(
      'DELIVERY_MANIFEST_PATH_INVALID',
      '交付清单包含非规范路径',
      409,
    );
  }
  assertSafeRelativePath(root, canonical);
  return canonical;
}

function expectedPackageDigest(input) {
  const digest = String(record(input).expectedPackageDigest || '').trim().toLowerCase();
  if (!digest) {
    throw new AgentControlDeliveryError(
      'DELIVERY_EXPECTED_DIGEST_REQUIRED',
      '校验交付包必须提供创建交付包时单独保存的 packageDigest；不能只信任包内清单',
      400,
    );
  }
  if (!/^[a-f0-9]{64}$/.test(digest)) {
    throw new AgentControlDeliveryError(
      'DELIVERY_EXPECTED_DIGEST_INVALID',
      '固定的 packageDigest 必须是 64 位 SHA-256',
      400,
    );
  }
  return digest;
}

function expectedPackageDirectories(filePaths) {
  const directories = new Set();
  for (const relativePath of filePaths) {
    let current = path.posix.dirname(relativePath);
    while (current && current !== '.') {
      directories.add(current);
      current = path.posix.dirname(current);
    }
  }
  return directories;
}

function scanPackageEntries(root) {
  const entries = new Map();
  const pending = [{ absolute: root, relativePath: '' }];
  while (pending.length) {
    const current = pending.pop();
    let children;
    try {
      children = fs.readdirSync(current.absolute, { withFileTypes: true });
    } catch (_) {
      throw new AgentControlDeliveryError(
        'DELIVERY_PACKAGE_UNREADABLE',
        '交付包目录无法完整读取',
        409,
      );
    }
    for (const child of children) {
      const relativePath = current.relativePath
        ? `${current.relativePath}/${child.name}`
        : child.name;
      const absolute = path.join(current.absolute, child.name);
      let stat;
      try {
        stat = fs.lstatSync(absolute);
      } catch (_) {
        throw new AgentControlDeliveryError(
          'DELIVERY_PACKAGE_UNREADABLE',
          '交付包内容在校验期间发生变化',
          409,
        );
      }
      const kind = stat.isSymbolicLink()
        ? 'symlink'
        : stat.isDirectory()
          ? 'directory'
          : stat.isFile()
            ? 'file'
            : 'other';
      entries.set(relativePath, { absolute, kind, size: Number(stat.size) || 0 });
      if (entries.size > MAX_PACKAGE_ENTRIES) {
        throw new AgentControlDeliveryError(
          'DELIVERY_PACKAGE_ENTRY_LIMIT_EXCEEDED',
          `交付包内容超过 ${MAX_PACKAGE_ENTRIES} 项，已停止校验`,
          413,
        );
      }
      if (kind === 'directory') pending.push({ absolute, relativePath });
    }
  }
  return entries;
}

function inspectExistingPackage(target) {
  const raw = String(target || '');
  if (!path.isAbsolute(raw)) {
    throw new AgentControlDeliveryError('DELIVERY_PATH_INVALID', '校验交付包必须使用绝对目录');
  }
  const absolute = path.resolve(raw);
  let stat;
  try {
    stat = fs.lstatSync(absolute);
  } catch (_) {
    throw new AgentControlDeliveryError('DELIVERY_PACKAGE_NOT_FOUND', '找不到交付包目录', 404);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new AgentControlDeliveryError('DELIVERY_PACKAGE_INVALID', '交付包必须是普通目录，不能是链接');
  }
  return { absolute, basename: path.basename(absolute) };
}

function publicPackagePreview(collection, target, scope = {}) {
  return {
    schema: 't8-agent-delivery-preview-v1',
    summary: `交付 ${collection.items.length} 个已校验素材到 ${target.basename}`,
    riskLevel: 'L2',
    projectId: String(scope.projectId || ''),
    canvasId: String(scope.canvasId || ''),
    currentRevision: Number(scope.canvasRevision) || null,
    catalogRevision: collection.catalogRevision,
    operationCount: collection.items.length,
    destination: `你选择的本机目录 / ${target.basename}`,
    package: {
      name: target.basename,
      scope: collection.scope,
      itemCount: collection.items.length,
      totalBytes: collection.totalBytes,
      selectionDigest: collection.selectionDigest,
      assets: collection.items.map((item) => ({
        assetId: item.assetId,
        kind: item.kind,
        filename: item.filename,
        size: item.size,
        sha256: item.sha256,
        renditionRole: item.renditionRole,
        licenseStatus: item.license.status,
      })),
    },
    providerTransfer: {
      occursNow: false,
      scope: 'none',
      message: '只把已校验素材复制到本机交付目录，不调用 AI Provider，也不转码。',
    },
    changes: [{
      type: 'delivery.package',
      targetType: 'directory',
      targetId: target.basename,
      fields: ['assetIds', 'contentHashes', 'destination', 'manifest', 'licenses'],
    }],
    warnings: [
      '不会覆盖已有目录；画布 revision、素材目录或任一素材哈希变化后会停止交付。',
      '只有素材元数据能证明 master/proxy/original 时才会这样标记；其余素材放入 media 并标记 unknown。',
      ...(collection.licenseSummary.unknown ? [`${collection.licenseSummary.unknown} 个素材的许可状态未知，发布前需要人工确认。`] : []),
    ],
  };
}

function createAgentControlDeliveryService(options = {}) {
  const database = options.database;

  function requireDatabase() {
    if (!database) throw new AgentControlDeliveryError('DELIVERY_UNAVAILABLE', '当前画布没有可用的交付服务', 503);
  }

  function internalAsset(assetId, projectId) {
    const asset = database.getAsset(String(assetId || ''));
    if (!asset || String(asset.projectId || '') !== String(projectId || '')) return null;
    return asset;
  }

  async function collect(document, input = {}) {
    requireDatabase();
    const projectId = String(input.projectId || document?.projectId || '');
    const canvasId = String(input.canvasId || document?.canvasId || document?.id || '');
    if (!projectId || String(document?.projectId || '') !== projectId) {
      throw new AgentControlDeliveryError('DELIVERY_SCOPE_INVALID', '交付范围不存在或不属于当前项目', 404);
    }
    const scope = input.scope === 'project' ? 'project' : 'canvas';
    const explicit = unique(input.assetIds);
    const selectedIds = explicit.length
      ? explicit
      : scope === 'project'
        ? projectAssetIds(database, projectId)
        : extractAssetIds(document);
    if (selectedIds.length > MAX_DELIVERY_ASSETS) {
      throw new AgentControlDeliveryError(
        'DELIVERY_ASSET_LIMIT_EXCEEDED',
        `一次最多交付 ${MAX_DELIVERY_ASSETS} 个素材，请缩小范围`,
        413,
      );
    }
    const items = [];
    const exclusions = [];
    for (const assetId of selectedIds) {
      const asset = internalAsset(assetId, projectId);
      if (!asset) {
        exclusions.push({ assetId, reasonCode: 'asset-not-found', message: '素材不存在或不是项目素材' });
        continue;
      }
      const contentHash = boundedText(asset.contentHash, 64).toLowerCase();
      if (!/^[a-f0-9]{64}$/.test(contentHash)) {
        exclusions.push({ assetId, reasonCode: 'content-hash-missing', message: '素材缺少可校验哈希' });
        continue;
      }
      const verified = await openVerifiedAssetMedia(asset);
      if (!verified) {
        exclusions.push({ assetId, reasonCode: 'media-unavailable', message: '素材原件缺失或哈希校验失败' });
        continue;
      }
      try {
        items.push(deliveryAssetView(asset, items.length));
      } finally {
        try { await verified.handle.close(); } catch (_) {}
      }
    }
    const catalogRevision = Number(database.getAssetCatalogRevision(projectId)) || 1;
    const licenseSummary = items.reduce((summary, item) => {
      const key = item.license.status === 'unknown' ? 'unknown' : 'known';
      summary[key] += 1;
      return summary;
    }, { known: 0, unknown: 0 });
    const collection = {
      schema: 't8-agent-delivery-collection-v1',
      projectId,
      canvasId,
      canvasRevision: Number(document?.revision) || 0,
      catalogRevision,
      scope,
      requestedAssetIds: selectedIds,
      items,
      exclusions,
      totalBytes: items.reduce((total, item) => total + item.size, 0),
      licenseSummary,
      ready: items.length > 0 && exclusions.length === 0,
    };
    collection.selectionDigest = sha256(stableJson({
      projectId,
      canvasId,
      canvasRevision: collection.canvasRevision,
      catalogRevision,
      scope,
      requestedAssetIds: selectedIds,
      items: items.map((item) => ({
        assetId: item.assetId,
        sha256: item.sha256,
        relativePath: item.relativePath,
      })),
      exclusions,
    }));
    return collection;
  }

  async function inspectPackage(document, input = {}) {
    const collection = await collect(document, input);
    if (!collection.items.length) {
      throw new AgentControlDeliveryError(
        'DELIVERY_NO_VERIFIED_ASSETS',
        collection.requestedAssetIds.length
          ? '所选素材都无法通过原件与哈希校验，不能创建空交付包'
          : '当前范围没有已持久化素材；请先生成或导入素材，再交付',
        409,
        { exclusions: collection.exclusions },
      );
    }
    if (collection.exclusions.length) {
      throw new AgentControlDeliveryError(
        'DELIVERY_INCOMPLETE',
        `有 ${collection.exclusions.length} 个素材缺失或校验失败；不会静默创建不完整交付包`,
        409,
        { exclusions: collection.exclusions },
      );
    }
    const target = inspectPackageTarget(input.targetPath);
    return {
      collection,
      target,
      preview: publicPackagePreview(collection, target, {
        projectId: collection.projectId,
        canvasId: collection.canvasId,
        canvasRevision: collection.canvasRevision,
      }),
    };
  }

  async function packageDelivery(document, expected) {
    requireDatabase();
    const current = await collect(document, {
      projectId: expected?.collection?.projectId,
      canvasId: expected?.collection?.canvasId,
      scope: expected?.collection?.scope,
      assetIds: expected?.collection?.requestedAssetIds,
    });
    if (!current.ready
      || current.selectionDigest !== expected?.collection?.selectionDigest
      || current.canvasRevision !== expected?.collection?.canvasRevision
      || current.catalogRevision !== expected?.collection?.catalogRevision) {
      throw new AgentControlDeliveryError(
        'DELIVERY_SOURCE_CHANGED',
        '画布或素材在批准后发生变化，未创建交付包；请重新收集并确认',
        409,
        { exclusions: current.exclusions },
      );
    }
    const target = inspectPackageTarget(expected?.target?.absolute);
    if (target.absolute !== expected?.target?.absolute || target.basename !== expected?.target?.basename) {
      throw new AgentControlDeliveryError('DELIVERY_TARGET_CHANGED', '交付目标在批准后发生变化，未创建交付包', 409);
    }
    fs.mkdirSync(path.dirname(target.absolute), { recursive: true });
    const staging = path.join(
      path.dirname(target.absolute),
      `.${target.basename}.${process.pid}.${crypto.randomUUID()}.part`,
    );
    try {
      fs.mkdirSync(staging, { recursive: false, mode: 0o700 });
      const packagedItems = [];
      for (const item of current.items) {
        const asset = internalAsset(item.assetId, current.projectId);
        const verified = asset ? await openVerifiedAssetMedia(asset) : null;
        if (!verified) {
          throw new AgentControlDeliveryError(
            'DELIVERY_SOURCE_CHANGED',
            `素材 ${item.assetId} 在复制前无法通过校验，交付已停止`,
            409,
          );
        }
        const destination = assertSafeRelativePath(staging, item.relativePath);
        try {
          fs.mkdirSync(path.dirname(destination), { recursive: true });
          const output = fs.createWriteStream(destination, { flags: 'wx', mode: 0o600 });
          await pipeline(verified.handle.createReadStream(), output);
          const actualHash = await hashFile(destination);
          const actualSize = fs.statSync(destination).size;
          if (actualHash !== item.sha256 || (item.size > 0 && actualSize !== item.size)) {
            throw new AgentControlDeliveryError(
              'DELIVERY_COPY_MISMATCH',
              `素材 ${item.assetId} 复制后哈希或大小不一致，交付已停止`,
              409,
            );
          }
          packagedItems.push({ ...item, size: actualSize });
        } finally {
          try { await verified.handle.close(); } catch (_) {}
        }
      }
      const licenses = {
        schema: LICENSE_SCHEMA,
        generatedAt: new Date().toISOString(),
        items: packagedItems.map((item) => ({
          assetId: item.assetId,
          relativePath: item.relativePath,
          ...item.license,
        })),
        warning: current.licenseSummary.unknown
          ? '许可状态 unknown 的素材必须由创作者在公开发布前确认。'
          : null,
      };
      const licensesJson = `${JSON.stringify(licenses, null, 2)}\n`;
      const licensesDigest = sha256(licensesJson);
      fs.writeFileSync(path.join(staging, DELIVERY_LICENSES_FILENAME), licensesJson, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      });
      const manifest = {
        schema: DELIVERY_SCHEMA,
        generatedAt: new Date().toISOString(),
        projectId: current.projectId,
        canvasId: current.canvasId,
        canvasRevision: current.canvasRevision,
        catalogRevision: current.catalogRevision,
        scope: current.scope,
        selectionDigest: current.selectionDigest,
        itemCount: packagedItems.length,
        totalBytes: packagedItems.reduce((total, item) => total + item.size, 0),
        items: packagedItems,
        licenses: {
          relativePath: DELIVERY_LICENSES_FILENAME,
          sha256: licensesDigest,
          known: current.licenseSummary.known,
          unknown: current.licenseSummary.unknown,
        },
        verification: {
          algorithm: 'sha256',
          command: 'zcanvas delivery verify --from <absolute-package-directory> --digest <pinned-package-digest>',
        },
      };
      manifest.packageDigest = manifestDigest(manifest);
      fs.writeFileSync(
        path.join(staging, DELIVERY_MANIFEST_FILENAME),
        `${JSON.stringify(manifest, null, 2)}\n`,
        { encoding: 'utf8', flag: 'wx', mode: 0o600 },
      );
      fs.renameSync(staging, target.absolute);
      return {
        schema: 't8-agent-delivery-result-v1',
        packageName: target.basename,
        manifestFilename: DELIVERY_MANIFEST_FILENAME,
        licensesFilename: DELIVERY_LICENSES_FILENAME,
        itemCount: manifest.itemCount,
        totalBytes: manifest.totalBytes,
        packageDigest: manifest.packageDigest,
        licenseSummary: current.licenseSummary,
        files: packagedItems.map((item) => ({
          assetId: item.assetId,
          relativePath: item.relativePath,
          size: item.size,
          sha256: item.sha256,
        })),
      };
    } catch (error) {
      try { fs.rmSync(staging, { recursive: true, force: true }); } catch (_) {}
      throw error;
    }
  }

  async function verifyPackage(targetPath, input = {}) {
    const pinnedDigest = expectedPackageDigest(input);
    const target = inspectExistingPackage(targetPath);
    const manifestPath = path.join(target.absolute, DELIVERY_MANIFEST_FILENAME);
    let stat;
    try {
      stat = fs.lstatSync(manifestPath);
    } catch (_) {
      throw new AgentControlDeliveryError(
        'DELIVERY_MANIFEST_MISSING',
        `交付包缺少 ${DELIVERY_MANIFEST_FILENAME}`,
        404,
      );
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > MAX_MANIFEST_BYTES) {
      throw new AgentControlDeliveryError('DELIVERY_MANIFEST_INVALID', '交付清单不是安全的普通 JSON 文件', 409);
    }
    let manifest;
    let manifestBytes;
    try {
      manifestBytes = fs.readFileSync(manifestPath);
      manifest = JSON.parse(manifestBytes.toString('utf8'));
    } catch (_) {
      throw new AgentControlDeliveryError('DELIVERY_MANIFEST_INVALID', '交付清单 JSON 无法解析', 409);
    }
    if (manifest?.schema !== DELIVERY_SCHEMA
      || !Array.isArray(manifest.items)
      || manifest.items.length > MAX_DELIVERY_ASSETS
      || !/^[a-f0-9]{64}$/.test(String(manifest.packageDigest || ''))
      || manifestDigest(manifest) !== manifest.packageDigest) {
      throw new AgentControlDeliveryError('DELIVERY_MANIFEST_INVALID', '交付清单结构或摘要无效', 409);
    }
    if (manifest.packageDigest !== pinnedDigest) {
      throw new AgentControlDeliveryError(
        'DELIVERY_PACKAGE_DIGEST_MISMATCH',
        '交付包清单摘要与调用方固定的 packageDigest 不一致；包可能已被替换或重写',
        409,
        {
          expectedPackageDigest: pinnedDigest,
          actualPackageDigest: manifest.packageDigest,
        },
      );
    }
    const failures = [];
    const expectedFiles = new Set([DELIVERY_MANIFEST_FILENAME]);
    const manifestPaths = new Set();
    const invalidItemIndexes = new Set();
    let declaredItemsBytes = 0;
    if (!Number.isSafeInteger(manifest.itemCount)
      || manifest.itemCount < 0
      || manifest.itemCount !== manifest.items.length) {
      failures.push({
        relativePath: DELIVERY_MANIFEST_FILENAME,
        reasonCode: 'manifest-item-count-mismatch',
      });
    }
    for (const [itemIndex, item] of manifest.items.entries()) {
      try {
        const relativePath = canonicalManifestPath(target.absolute, item?.relativePath);
        if (relativePath === DELIVERY_MANIFEST_FILENAME
          || relativePath === DELIVERY_LICENSES_FILENAME
          || manifestPaths.has(relativePath)) {
          throw new Error('duplicate-or-reserved-manifest-path');
        }
        if (!/^[a-f0-9]{64}$/.test(String(item?.sha256 || ''))
          || !Number.isSafeInteger(item?.size)
          || item.size < 0) {
          throw new Error('invalid-item-integrity-metadata');
        }
        manifestPaths.add(relativePath);
        expectedFiles.add(relativePath);
        declaredItemsBytes += item.size;
        if (!Number.isSafeInteger(declaredItemsBytes)) {
          throw new Error('item-total-overflow');
        }
      } catch (error) {
        invalidItemIndexes.add(itemIndex);
        failures.push({
          assetId: boundedText(sanitizePublicValue(item?.assetId), 240),
          relativePath: boundedText(sanitizePublicValue(item?.relativePath), 500),
          reasonCode: String(error?.message || 'invalid-item-metadata').slice(0, 120),
        });
      }
    }
    if (!Number.isSafeInteger(manifest.totalBytes)
      || manifest.totalBytes < 0
      || manifest.totalBytes !== declaredItemsBytes) {
      failures.push({
        relativePath: DELIVERY_MANIFEST_FILENAME,
        reasonCode: 'manifest-total-bytes-mismatch',
      });
    }
    let licenseRelativePath = '';
    try {
      licenseRelativePath = canonicalManifestPath(target.absolute, manifest.licenses?.relativePath);
      if (licenseRelativePath !== DELIVERY_LICENSES_FILENAME) {
        throw new Error('unexpected-license-manifest-path');
      }
      if (!/^[a-f0-9]{64}$/.test(String(manifest.licenses?.sha256 || ''))) {
        throw new Error('invalid-license-manifest-digest');
      }
      expectedFiles.add(licenseRelativePath);
    } catch (error) {
      failures.push({
        relativePath: boundedText(sanitizePublicValue(manifest.licenses?.relativePath), 500),
        reasonCode: String(error?.message || 'invalid-license-manifest').slice(0, 120),
      });
    }
    const expectedDirectories = expectedPackageDirectories(expectedFiles);
    const packageEntries = scanPackageEntries(target.absolute);
    for (const [relativePath, entry] of packageEntries.entries()) {
      if (entry.kind === 'file' && expectedFiles.has(relativePath)) continue;
      if (entry.kind === 'directory' && expectedDirectories.has(relativePath)) continue;
      failures.push({
        relativePath: boundedText(sanitizePublicValue(relativePath), 500),
        reasonCode: entry.kind === 'file'
          ? 'unexpected-package-file'
          : entry.kind === 'directory'
            ? 'unexpected-package-directory'
            : entry.kind === 'symlink'
              ? 'package-symlink-not-allowed'
              : 'unexpected-package-entry',
      });
    }
    let verifiedBytes = 0;
    let verifiedItems = 0;
    for (const [itemIndex, item] of manifest.items.entries()) {
      if (invalidItemIndexes.has(itemIndex)) continue;
      try {
        const relativePath = canonicalManifestPath(target.absolute, item.relativePath);
        const entry = packageEntries.get(relativePath);
        if (!entry || entry.kind !== 'file') throw new Error('not-regular-file');
        const actualHash = await hashFile(entry.absolute);
        if (actualHash !== item.sha256 || entry.size !== item.size) {
          throw new Error('hash-or-size-mismatch');
        }
        verifiedBytes += entry.size;
        verifiedItems += 1;
      } catch (error) {
        failures.push({
          assetId: boundedText(sanitizePublicValue(item?.assetId), 240),
          relativePath: boundedText(sanitizePublicValue(item?.relativePath), 500),
          reasonCode: String(error?.message || 'verification-failed').slice(0, 120),
        });
      }
    }
    if (licenseRelativePath) {
      try {
        const licenseEntry = packageEntries.get(licenseRelativePath);
        if (!licenseEntry || licenseEntry.kind !== 'file'
          || await hashFile(licenseEntry.absolute) !== manifest.licenses?.sha256) {
          failures.push({ relativePath: DELIVERY_LICENSES_FILENAME, reasonCode: 'license-manifest-mismatch' });
        }
      } catch (_) {
        failures.push({ relativePath: DELIVERY_LICENSES_FILENAME, reasonCode: 'license-manifest-missing' });
      }
    }
    if (verifiedBytes !== manifest.totalBytes) {
      failures.push({
        relativePath: DELIVERY_MANIFEST_FILENAME,
        reasonCode: 'verified-total-bytes-mismatch',
      });
    }
    try {
      if (!fs.readFileSync(manifestPath).equals(manifestBytes)) {
        failures.push({
          relativePath: DELIVERY_MANIFEST_FILENAME,
          reasonCode: 'manifest-changed-during-verification',
        });
      }
    } catch (_) {
      failures.push({
        relativePath: DELIVERY_MANIFEST_FILENAME,
        reasonCode: 'manifest-changed-during-verification',
      });
    }
    return {
      schema: 't8-agent-delivery-verification-v1',
      packageName: target.basename,
      packageDigest: manifest.packageDigest,
      itemCount: manifest.items.length,
      verifiedItems,
      verifiedBytes,
      valid: failures.length === 0,
      failures,
      licenseSummary: {
        known: Number(manifest.licenses?.known) || 0,
        unknown: Number(manifest.licenses?.unknown) || 0,
      },
    };
  }

  return {
    collect,
    inspectPackage,
    packageDelivery,
    verifyPackage,
  };
}

module.exports = {
  AgentControlDeliveryError,
  DELIVERY_SCHEMA,
  LICENSE_SCHEMA,
  MAX_DELIVERY_ASSETS,
  MAX_PACKAGE_ENTRIES,
  createAgentControlDeliveryService,
  extractAssetIds,
  inspectPackageTarget,
  manifestDigest,
  publicPackagePreview,
};
