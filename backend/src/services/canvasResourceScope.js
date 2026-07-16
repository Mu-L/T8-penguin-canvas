const crypto = require('node:crypto');

const MAX_RESOURCE_VISITS = 1_000_000;
const MAX_RESOURCE_DEPTH = 128;
const MAX_RESOURCE_ARRAY_ITEMS = 50_000;
const MAX_RESOURCE_OBJECT_KEYS = 10_000;
const MAX_EMBEDDED_SUBFLOW_DEPTH = 16;
const MAX_ASSET_REFERENCES = 2_000;
const MAX_SUBFLOW_REFERENCES = 512;
const SUBFLOW_DEFINITION_METADATA_KEYS = new Set([
  'baseRevision',
  'changeSummary',
  'createdAt',
  'createdBy',
  'id',
  'projectId',
  'publishedAt',
  'publishedBy',
  'revision',
  'updatedAt',
  'version',
]);

function subflowReferenceKey(id, version) {
  return `${String(id || '')}\u0000${Number(version)}`;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

function canonicalSubflowContent(value, options = {}) {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalSubflowContent(item));
  }
  if (!value || typeof value !== 'object') return value;
  const output = {};
  const isSubflowNode = String(value.type || '') === 'subflow'
    && value.data
    && typeof value.data === 'object'
    && !Array.isArray(value.data);
  for (const [key, item] of Object.entries(value)) {
    if (options.root === true && SUBFLOW_DEFINITION_METADATA_KEYS.has(key)) continue;
    if (isSubflowNode && key === 'data') {
      const data = {};
      for (const [dataKey, dataValue] of Object.entries(item)) {
        if (dataKey === 'definition') continue;
        data[dataKey] = canonicalSubflowContent(dataValue);
      }
      output[key] = data;
      continue;
    }
    output[key] = canonicalSubflowContent(item);
  }
  return output;
}

function subflowDefinitionContentDigest(definition) {
  return crypto.createHash('sha256')
    .update(stableJson(canonicalSubflowContent(definition, { root: true })))
    .digest('hex');
}

function collectCanvasResourceReferences(document, options = {}) {
  const assetIds = new Set();
  const assetUrls = new Set();
  const subflowReferences = new Map();
  const subflowReferenceKeys = new Set();
  const subflowPinMismatches = [];
  const subflowContentMismatches = [];
  const scannedSubflowContainers = new WeakSet();
  const scannedSubflowNodes = new WeakSet();
  const validatedEmbeddedDefinitions = new WeakSet();
  let visited = 0;
  let truncated = false;

  const visit = (value, key = '', depth = 0) => {
    if (depth > MAX_RESOURCE_DEPTH || visited >= MAX_RESOURCE_VISITS) {
      truncated = true;
      return;
    }
    visited += 1;
    if (typeof value === 'string') {
      const text = value.trim();
      if (!text) return;
      if (/^(https?:\/\/|\/files\/|\/input\/|\/output\/)/i.test(text)) {
        if (assetUrls.size >= MAX_ASSET_REFERENCES) truncated = true;
        else assetUrls.add(text.slice(0, 16_384));
      }
      return;
    }
    if (Array.isArray(value)) {
      const generalLimit = Math.min(value.length, MAX_RESOURCE_ARRAY_ITEMS);
      for (let index = 0; index < generalLimit; index += 1) {
        visit(value[index], key, depth + 1);
        if (visited >= MAX_RESOURCE_VISITS) break;
      }
      if (value.length > MAX_RESOURCE_ARRAY_ITEMS) truncated = true;
      return;
    }
    if (!value || typeof value !== 'object') return;
    const entries = Object.entries(value);
    const generalLimit = Math.min(entries.length, MAX_RESOURCE_OBJECT_KEYS);
    for (let index = 0; index < generalLimit; index += 1) {
      const [childKey, entry] = entries[index];
      visit(entry, childKey, depth + 1);
      if (visited >= MAX_RESOURCE_VISITS) break;
    }
    if (entries.length > MAX_RESOURCE_OBJECT_KEYS) truncated = true;
  };

  const addSubflowReference = (definitionId, version) => {
    const normalizedId = String(definitionId || '').trim();
    const normalizedVersion = Number(version);
    if (!normalizedId || !Number.isInteger(normalizedVersion) || normalizedVersion < 1) return;
    const referenceKey = subflowReferenceKey(normalizedId, normalizedVersion);
    if (subflowReferenceKeys.has(referenceKey)) return;
    if (subflowReferenceKeys.size >= MAX_SUBFLOW_REFERENCES) {
      truncated = true;
      return;
    }
    subflowReferenceKeys.add(referenceKey);
    if (!subflowReferences.has(normalizedId)) subflowReferences.set(normalizedId, new Set());
    subflowReferences.get(normalizedId).add(normalizedVersion);
  };

  const addAssetId = (assetId) => {
    const normalizedId = String(assetId || '').trim();
    if (!normalizedId) return;
    if (assetIds.size >= MAX_ASSET_REFERENCES) {
      truncated = true;
      return;
    }
    assetIds.add(normalizedId.slice(0, 240));
  };

  const addSubflowMismatch = (target, mismatch) => {
    if (target.length >= MAX_SUBFLOW_REFERENCES) {
      truncated = true;
      return;
    }
    target.push(mismatch);
  };

  const validateEmbeddedDefinition = (definition, context = {}) => {
    if (!definition || typeof definition !== 'object') return;
    if (validatedEmbeddedDefinitions.has(definition)) return;
    validatedEmbeddedDefinitions.add(definition);
    const definitionId = String(definition.id || '').trim();
    const version = Number(definition.version);
    if (!definitionId || !Number.isInteger(version) || version < 1) return;
    if (typeof options.validateEmbeddedSubflow !== 'function') return;
    let valid = false;
    try {
      valid = options.validateEmbeddedSubflow({
        nodeId: String(context.nodeId || '').slice(0, 240),
        definitionId,
        version,
        projectId: String(context.projectId || definition.projectId || '').trim(),
        definition,
        contentDigest: subflowDefinitionContentDigest(definition),
      }) === true;
    } catch (_) {
      valid = false;
    }
    if (!valid) {
      addSubflowMismatch(subflowContentMismatches, {
        nodeId: String(context.nodeId || '').slice(0, 240),
        definitionId: definitionId.slice(0, 240),
        version,
      });
    }
  };

  const scanSubflowReferenceObject = (data, nodeId = '', depth = 0, ancestors = new Set()) => {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return;
    const embedded = data.definition && typeof data.definition === 'object' && !Array.isArray(data.definition)
      ? data.definition
      : null;
    const pinnedId = String(data.definitionId || '').trim();
    const pinnedVersion = Number(data.definitionVersion);
    const embeddedId = String(embedded?.id || '').trim();
    const embeddedVersion = Number(embedded?.version);
    const pinnedProjectId = String(data.definitionProjectId || '').trim();
    const embeddedProjectId = String(embedded?.projectId || '').trim();

    addSubflowReference(pinnedId, pinnedVersion);
    addSubflowReference(embeddedId, embeddedVersion);

    const pinnedIdentityValid = Boolean(pinnedId)
      && Number.isInteger(pinnedVersion)
      && pinnedVersion >= 1;
    const embeddedIdentityValid = Boolean(embeddedId)
      && Number.isInteger(embeddedVersion)
      && embeddedVersion >= 1;
    if (embedded && (
      !embeddedIdentityValid
      || (pinnedIdentityValid && (
        pinnedId !== embeddedId
        || pinnedVersion !== embeddedVersion
        || (pinnedProjectId && embeddedProjectId && pinnedProjectId !== embeddedProjectId)
      ))
    )) {
      addSubflowMismatch(subflowPinMismatches, {
        nodeId: String(nodeId || '').slice(0, 240),
        pinnedId: pinnedId.slice(0, 240),
        pinnedVersion: Number.isInteger(pinnedVersion) ? pinnedVersion : null,
        embeddedId: embeddedId.slice(0, 240),
        embeddedVersion: Number.isInteger(embeddedVersion) ? embeddedVersion : null,
      });
    }
    if (embeddedIdentityValid) {
      validateEmbeddedDefinition(embedded, {
        nodeId,
        projectId: embeddedProjectId || pinnedProjectId,
      });
    }
    if (embedded) scanSubflowContainer(embedded, depth + 1, ancestors);
  };

  const scanSubflowNode = (node, depth = 0, ancestors = new Set()) => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return;
    if (scannedSubflowNodes.has(node)) return;
    scannedSubflowNodes.add(node);
    const data = node.data && typeof node.data === 'object' && !Array.isArray(node.data)
      ? node.data
      : {};
    scanSubflowReferenceObject(data, node.id, depth, ancestors);
  };

  const scanSubflowContainer = (container, depth = 0, ancestors = new Set()) => {
    if (!container || typeof container !== 'object') return;
    if (depth > MAX_EMBEDDED_SUBFLOW_DEPTH) {
      truncated = true;
      return;
    }
    if (ancestors.has(container)) return;
    if (scannedSubflowContainers.has(container)) return;
    scannedSubflowContainers.add(container);
    const nextAncestors = new Set(ancestors);
    nextAncestors.add(container);
    const nodes = Array.isArray(container.nodes) ? container.nodes : [];
    const nodeLimit = Math.min(nodes.length, MAX_RESOURCE_ARRAY_ITEMS);
    for (let index = 0; index < nodeLimit; index += 1) {
      const node = nodes[index];
      if (String(node?.type || '') !== 'subflow') continue;
      scanSubflowNode(node, depth, nextAncestors);
    }
    if (nodes.length > MAX_RESOURCE_ARRAY_ITEMS) truncated = true;
  };

  const scanNestedSubflowContainers = (value, depth = 0, seen = new WeakSet()) => {
    if (depth > MAX_RESOURCE_DEPTH) {
      truncated = true;
      return;
    }
    if (!value || typeof value !== 'object') return;
    if (seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      const limit = Math.min(value.length, MAX_RESOURCE_ARRAY_ITEMS);
      for (let index = 0; index < limit; index += 1) {
        scanNestedSubflowContainers(value[index], depth + 1, seen);
      }
      if (value.length > MAX_RESOURCE_ARRAY_ITEMS) truncated = true;
      return;
    }
    if (String(value.type || '') === 'subflow') {
      scanSubflowNode(value, 0);
    }
    const nodeData = typeof value.type === 'string'
      && value.data
      && typeof value.data === 'object'
      && !Array.isArray(value.data)
      ? value.data
      : null;
    if (nodeData) addAssetId(nodeData.sourceAssetId);
    const definitionContainer = typeof value.id === 'string'
      && Array.isArray(value.nodes)
      && Array.isArray(value.edges);
    if (definitionContainer && Array.isArray(value.assetRefs)) {
      const limit = Math.min(value.assetRefs.length, MAX_ASSET_REFERENCES);
      for (let index = 0; index < limit; index += 1) {
        addAssetId(value.assetRefs[index]);
      }
      if (value.assetRefs.length > MAX_ASSET_REFERENCES) truncated = true;
    }
    const embeddedDefinition = definitionContainer
      && Number.isInteger(Number(value.version))
      && Number(value.version) >= 1;
    const skipRootDefinition = depth === 0 && options.validateRootSubflowDefinition === false;
    if (embeddedDefinition && !skipRootDefinition) {
      addSubflowReference(value.id, value.version);
      validateEmbeddedDefinition(value, { projectId: value.projectId });
    }
    const containsSubflowReference = Object.prototype.hasOwnProperty.call(value, 'definitionId')
      || Object.prototype.hasOwnProperty.call(value, 'definitionVersion')
      || (value.definition
        && typeof value.definition === 'object'
        && !Array.isArray(value.definition)
        && Array.isArray(value.definition.nodes)
        && Array.isArray(value.definition.edges));
    if (containsSubflowReference) scanSubflowReferenceObject(value);
    if (Array.isArray(value.nodes)) scanSubflowContainer(value);
    const entries = Object.entries(value);
    const limit = Math.min(entries.length, MAX_RESOURCE_OBJECT_KEYS);
    for (let index = 0; index < limit; index += 1) {
      scanNestedSubflowContainers(entries[index][1], depth + 1, seen);
    }
    if (entries.length > MAX_RESOURCE_OBJECT_KEYS) truncated = true;
  };

  visit(document);
  scanNestedSubflowContainers(document);

  if (subflowPinMismatches.length > MAX_SUBFLOW_REFERENCES) {
    subflowPinMismatches.length = MAX_SUBFLOW_REFERENCES;
    truncated = true;
  }
  if (subflowContentMismatches.length > MAX_SUBFLOW_REFERENCES) {
    subflowContentMismatches.length = MAX_SUBFLOW_REFERENCES;
    truncated = true;
  }

  for (const [definitionId, versions] of subflowReferences) {
    if (!definitionId || versions.size === 0) {
      subflowReferences.delete(definitionId);
      continue;
    }
    for (const version of [...versions]) {
      if (!Number.isInteger(version) || version < 1) versions.delete(version);
    }
    if (versions.size === 0) subflowReferences.delete(definitionId);
  }

  return {
    assetIds,
    assetUrls,
    subflowReferences,
    subflowPinMismatches,
    subflowContentMismatches,
    truncated,
    visited,
  };
}

module.exports = {
  MAX_ASSET_REFERENCES,
  MAX_SUBFLOW_REFERENCES,
  collectCanvasResourceReferences,
  subflowDefinitionContentDigest,
  subflowReferenceKey,
};
