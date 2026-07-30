const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  validateCreativeCapabilityHandlers,
} = require('./agentControlCapabilityHandlers');

const SOURCE_ROOT = path.resolve(__dirname, '..', '..', '..');
const CAPABILITY_SCHEMA = 't8-creative-capability-manifest-v1';
const CAPABILITY_ID_RE = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/;
const CLI_NAME_RE = /^[a-z][a-z0-9-]*$/;
const APPROVAL_LEVELS = new Set(['L0', 'L1', 'L2', 'L3']);
const NODE_TYPE_SELECTORS = new Set(['creator-visible']);
const READ_ONLY_OPERATIONS = new Set(['inspect', 'plan', 'preview', 'compare', 'verify']);
const RUNTIME_PROVIDERS = new Set(['zhenzhen', 'seedance-nz', 'fal', 'grok-oauth']);

const {
  assertCapabilityCoverageReceipt,
} = require(existingFile([
  String(process.resourcesPath || '').trim()
    ? path.join(process.resourcesPath, 'tools', 'zcanvas-cli', 'src', 'capabilityCoverage.cjs')
    : '',
  path.join(SOURCE_ROOT, 'tools', 'zcanvas-cli', 'src', 'capabilityCoverage.cjs'),
]));

function configuredSecret(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function credentialSettings(options = {}) {
  if (typeof options.credentialSettingsProvider === 'function') {
    const provided = options.credentialSettingsProvider();
    return provided && typeof provided === 'object' && !Array.isArray(provided) ? provided : {};
  }
  const settingsFile = String(options.settingsFile || '').trim();
  if (!settingsFile || !fs.existsSync(settingsFile)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_) {
    return {};
  }
}

function classifiedCredentialField(value) {
  const hint = String(value || '').toLowerCase();
  if (hint.includes('gpt-image') || hint.includes('gpt2') || hint.includes('gpt_image') || hint.includes('gptimage')) return 'gptImageApiKey';
  if (hint.includes('nano-banana') || hint.includes('nano_banana') || hint.includes('nanobanana')
    || hint.includes('flash-image') || hint.includes('flash-lite-image') || hint.includes('gemini-3-pro-image')) return 'nanoBananaApiKey';
  if (hint.includes('midjourney') || /(?:^|[-_:/])mj(?:[-_:/]|$)/.test(hint)) return 'mjApiKey';
  if (hint.includes('veo')) return 'veoApiKey';
  if (hint.includes('sora')) return 'soraApiKey';
  if (hint.includes('grok')) return 'grokApiKey';
  if (hint.includes('seedance')) return 'seedanceApiKey';
  if (hint.includes('suno') || hint.includes('chirp')) return 'sunoApiKey';
  return '';
}

function runtimeCredentialContract(entry) {
  const provider = String(entry?.provider || '');
  if (provider === 'seedance-nz') {
    return { fields: ['zhenzhenSd2ApiKey'], label: '贞贞的平价AI小屋 API Key' };
  }
  if (provider === 'fal') {
    return { fields: ['zhenzhenApiKey'], label: '贞贞AI工坊 API Key' };
  }
  if (provider === 'zhenzhen') {
    if (entry?.kind === 'llm') {
      return { fields: ['llmApiKey'], label: '贞贞AI工坊独立 LLM Key' };
    }
    const hint = [entry?.id, entry?.model, entry?.action, entry?.family].filter(Boolean).join(' ');
    const classified = classifiedCredentialField(hint);
    return {
      fields: classified ? [classified, 'zhenzhenApiKey'] : ['zhenzhenApiKey'],
      label: classified ? '对应分类 Key 或贞贞AI工坊默认 Key' : '贞贞AI工坊 API Key',
    };
  }
  if (provider === 'grok-oauth') {
    return { fields: [], label: 'Grok OAuth 登录 / 绑定' };
  }
  return { fields: [], label: '当前平台凭据' };
}

function runtimeStatusOverride(entry, options = {}) {
  let value = null;
  if (typeof options.runtimeStatusProvider === 'function') {
    value = options.runtimeStatusProvider({ ...entry });
  } else if (options.runtimeStatuses && typeof options.runtimeStatuses === 'object') {
    value = options.runtimeStatuses[entry.id] || options.runtimeStatuses[entry.provider];
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function runtimeReadiness(entry, settings, options = {}) {
  const provider = String(entry?.provider || '');
  const compatibility = entry?.compatibility && typeof entry.compatibility === 'object'
    ? entry.compatibility
    : {};
  const credential = runtimeCredentialContract(entry);
  const override = runtimeStatusOverride(entry, options);
  const available = entry?.available !== false && compatibility.available !== false;
  let installed = compatibility.installed == null ? null : compatibility.installed === true;
  let credentialReady = compatibility.credentialReady == null
    ? null
    : compatibility.credentialReady === true;
  let regionReady = compatibility.regionReady == null ? null : compatibility.regionReady === true;
  if (RUNTIME_PROVIDERS.has(provider) && provider !== 'grok-oauth') {
    installed = true;
    credentialReady = credential.fields.some((field) => configuredSecret(settings[field]));
    regionReady = true;
  }
  for (const key of ['installed', 'credentialReady', 'regionReady']) {
    if (typeof override[key] === 'boolean' || override[key] === null) {
      if (key === 'installed') installed = override[key];
      if (key === 'credentialReady') credentialReady = override[key];
      if (key === 'regionReady') regionReady = override[key];
    }
  }
  const blockers = [];
  const addBlocker = (code, message) => blockers.push({ code, message });
  if (!available) addBlocker('runtime_unavailable', '当前模型或动作已停用');
  if (installed === false) addBlocker('runtime_component_missing', '当前功能组件未安装或未启用');
  if (installed == null) addBlocker('runtime_component_unknown', '尚未确认当前功能组件是否可用');
  if (credentialReady === false) addBlocker('runtime_credential_missing', `未设置${credential.label}`);
  if (credentialReady == null) addBlocker('runtime_credential_unknown', `尚未确认${credential.label}`);
  if (regionReady === false) addBlocker('runtime_region_blocked', '当前地区或线路不支持这个模型');
  if (regionReady == null) addBlocker('runtime_region_unknown', '尚未确认当前地区或线路是否可用');
  const executable = available
    && installed === true
    && credentialReady === true
    && regionReady === true;
  return {
    known: compatibility.known !== false,
    installed,
    credentialReady,
    regionReady,
    executable,
    available,
    requiresRuntimeCheck: true,
    blockers,
  };
}

function runtimeReadinessView(graph, options = {}) {
  const settings = credentialSettings(options);
  const entries = graph.runtime.entries.map((entry) => ({
    ...entry,
    readiness: runtimeReadiness(entry, settings, options),
  }));
  const summary = {
    known: entries.length,
    executable: entries.filter((entry) => entry.readiness.executable).length,
    blocked: entries.filter((entry) => !entry.readiness.executable).length,
    missingCredential: entries.filter((entry) => (
      entry.readiness.blockers.some((blocker) => blocker.code === 'runtime_credential_missing')
    )).length,
    unknownComponent: entries.filter((entry) => (
      entry.readiness.blockers.some((blocker) => blocker.code === 'runtime_component_unknown')
    )).length,
    unknownRegion: entries.filter((entry) => (
      entry.readiness.blockers.some((blocker) => blocker.code === 'runtime_region_unknown')
    )).length,
  };
  return { entries, summary };
}

function validateNodeCoverage(value) {
  const nodes = Array.isArray(value.nodes) ? value.nodes : [];
  const referenced = nodes.filter((node) => (node.capabilityIds || []).length > 0);
  const direct = nodes.filter((node) => node.accounting?.status === 'direct-capability');
  const internal = nodes.filter((node) => node.accounting?.status === 'internal-compat');
  const superseded = nodes.filter((node) => node.accounting?.status === 'semantic-superseded');
  const publicGaps = nodes.filter((node) => node.accounting?.status === 'public-capability-gap');
  const unexplained = nodes.filter((node) => node.accounting?.status === 'unexplained');
  const accountingStatuses = new Set([
    'direct-capability',
    'internal-compat',
    'semantic-superseded',
    'public-capability-gap',
    'unexplained',
  ]);
  const nodeMetadataValid = nodes.every((node) => {
    const referencedNode = (node.capabilityIds || []).length > 0;
    const accounting = node.accounting;
    if (!accounting || !accountingStatuses.has(String(accounting.status))
      || node.agentExposure !== accounting.status
      || node.coverageReason !== accounting.reasonCode
      || !String(accounting.reasonCode || '')
      || !Array.isArray(accounting.semanticCapabilityIds)
      || !Array.isArray(accounting.evidence)
      || accounting.evidence.length === 0) return false;
    if (referencedNode !== (accounting.status === 'direct-capability')) return false;
    if (referencedNode
      && JSON.stringify(accounting.semanticCapabilityIds) !== JSON.stringify(node.capabilityIds)) return false;
    if (!referencedNode && node.hidden !== true) return false;
    if (accounting.status === 'public-capability-gap') {
      return node.executable === true && Boolean(String(accounting.proposedCapabilityId || ''));
    }
    return accounting.status !== 'unexplained';
  });
  const listMatches = (items, expected, property = 'nodeType') => (
    Array.isArray(items)
    && items.length === expected.length
    && new Set(items.map((item) => String(property ? item?.[property] : item || ''))).size === items.length
    && expected.every((node) => items.some((item) => (
      String(property ? item?.[property] : item || '') === String(node.type)
    )))
  );
  if (Number(value.counts?.nodes) !== nodes.length
    || Number(value.counts?.referencedNodes) !== referenced.length
    || Number(value.counts?.unreferencedNodes) !== nodes.length - referenced.length
    || Number(value.counts?.directCapabilityNodes) !== direct.length
    || Number(value.counts?.internalCompatNodes) !== internal.length
    || Number(value.counts?.semanticSupersededNodes) !== superseded.length
    || Number(value.counts?.publicCapabilityGapNodes) !== publicGaps.length
    || Number(value.counts?.accountedNodes) !== (
      direct.length + internal.length + superseded.length + publicGaps.length
    )
    || Number(value.counts?.accountedNodes) !== nodes.length
    || Number(value.counts?.unexplainedNodes) !== unexplained.length
    || unexplained.length !== 0
    || !listMatches(value.gaps?.unreferencedNodeTypes, nodes.filter((node) => (
      (node.capabilityIds || []).length === 0
    )), null)
    || !listMatches(value.gaps?.internalCompatNodes, internal)
    || !listMatches(value.gaps?.semanticSupersededNodes, superseded)
    || !listMatches(value.gaps?.publicCapabilityGaps, publicGaps)
    || (value.gaps?.unexplainedNodeTypes || []).length !== 0
    || !nodeMetadataValid
    || direct.length !== referenced.length) {
    throw new Error('Creative capability graph node coverage is incomplete');
  }
}

function validateOperationRiskContracts(value) {
  let operationCount = 0;
  for (const capability of value.capabilities) {
    const supports = Array.isArray(capability.supports) ? capability.supports : [];
    const operations = Array.isArray(capability.operations) ? capability.operations : [];
    if (operations.length !== supports.length) {
      throw new Error(`Creative capability graph is missing operation risk contracts for ${capability.id}`);
    }
    supports.forEach((operation, index) => {
      const policy = operations[index];
      if (policy?.operation !== operation || !APPROVAL_LEVELS.has(String(policy?.riskLevel || ''))
        || !Array.isArray(policy?.requiredScopes)
        || typeof policy?.approvalRequired !== 'boolean'
        || (policy.approvalRequired !== (policy.riskLevel !== 'L0'))
        || (READ_ONLY_OPERATIONS.has(operation) && policy.riskLevel !== 'L0')) {
        throw new Error(`Creative capability graph has invalid operation risk contract for ${capability.id}.${operation}`);
      }
    });
    operationCount += operations.length;
  }
  if (Number(value.counts?.operations) !== operationCount
    || Number(value.counts?.missingOperationRisk) !== 0
    || (value.gaps?.missingOperationRisk || []).length !== 0) {
    throw new Error('Creative capability graph operation risk coverage is incomplete');
  }
}

function validateRuntimeCompatibility(value) {
  for (const entry of value.runtime.entries) {
    const compatibility = entry?.compatibility;
    if (!compatibility || compatibility.known !== true
      || compatibility.executable !== false
      || compatibility.requiresRuntimeCheck !== true
      || typeof compatibility.available !== 'boolean'
      || ![true, false, null].includes(compatibility.installed)
      || ![true, false, null].includes(compatibility.credentialReady)
      || ![true, false, null].includes(compatibility.regionReady)) {
      throw new Error(`Creative capability graph has invalid runtime compatibility for ${entry?.id || '(unknown)'}`);
    }
  }
}


let cached = null;
let cachedGraph = null;

function existingFile(candidates) {
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  throw new Error('Creative capability manifest is unavailable');
}

function creativeCapabilityManifestPath(options = {}) {
  const resourcesPath = String(options.resourcesPath || process.resourcesPath || '').trim();
  return existingFile([
    options.manifestPath,
    resourcesPath
      ? path.join(resourcesPath, 'tools', 'zcanvas-cli', 'creativeCapabilityManifest.json')
      : '',
    path.join(SOURCE_ROOT, 'tools', 'zcanvas-cli', 'creativeCapabilityManifest.json'),
  ]);
}
function creativeCapabilityGraphPath(options = {}) {
  const resourcesPath = String(options.resourcesPath || process.resourcesPath || '').trim();
  const candidates = [
    options.graphPath,
    resourcesPath
      ? path.join(resourcesPath, 'backend', 'shared', 'creativeCapabilityGraph.json')
      : '',
    resourcesPath
      ? path.join(resourcesPath, 'tools', 'zcanvas-cli', 'generated', 'creative-capability-graph.json')
      : '',
    path.join(SOURCE_ROOT, 'backend', 'src', 'shared', 'creativeCapabilityGraph.json'),
    path.join(SOURCE_ROOT, 'tools', 'zcanvas-cli', 'generated', 'creative-capability-graph.json'),
  ];
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  throw new Error('Creative capability graph is unavailable');
}

function assertStringArray(value, label, capabilityId) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) {
    throw new Error(`Creative capability ${capabilityId} has invalid ${label}`);
  }
}

function validateCreativeCapabilityManifest(value) {
  if (value?.schema !== CAPABILITY_SCHEMA || !Array.isArray(value.capabilities)) {
    throw new Error('Creative capability manifest schema is invalid');
  }
  if (value.principles?.directCanvasMutation !== false
    || value.principles?.previewBeforeApply !== true
    || value.principles?.explicitApprovalForWrites !== true) {
    throw new Error('Creative capability manifest weakens Agent Control safety principles');
  }
  const ids = new Set();
  const cliOperations = new Set();
  for (const capability of value.capabilities) {
    const id = String(capability?.id || '');
    if (!CAPABILITY_ID_RE.test(id) || ids.has(id)) {
      throw new Error(`Creative capability manifest contains invalid or duplicate id: ${id || '(empty)'}`);
    }
    ids.add(id);
    if (!String(capability?.creatorLabel || '').trim()
      || !String(capability?.summary || '').trim()
      || !String(capability?.category || '').trim()
      || !String(capability?.handler || '').trim()
      || !APPROVAL_LEVELS.has(String(capability?.approval || ''))) {
      throw new Error(`Creative capability ${id} is missing creator metadata, handler, or approval level`);
    }
    assertStringArray(capability.aliases, 'aliases', id);
    assertStringArray(capability.requiredScopes, 'requiredScopes', id);
    assertStringArray(capability.supports, 'supports', id);
    assertStringArray(capability.evidence, 'evidence', id);
    assertStringArray(capability.nodeTypes, 'nodeTypes', id);
    const nodeTypeSelector = String(capability.nodeTypeSelector || '').trim();
    if (nodeTypeSelector && !NODE_TYPE_SELECTORS.has(nodeTypeSelector)) {
      throw new Error(`Creative capability ${id} has invalid nodeTypeSelector`);
    }
    assertStringArray(capability.inputKinds, 'inputKinds', id);
    assertStringArray(capability.outputKinds, 'outputKinds', id);
    const cliCommand = String(capability?.cli?.command || '').trim();
    const cliSubcommand = String(capability?.cli?.subcommand || '').trim();
    const cliOperation = `${cliCommand}.${cliSubcommand}`;
    if (!CLI_NAME_RE.test(cliCommand)
      || !CLI_NAME_RE.test(cliSubcommand)
      || cliOperations.has(cliOperation)) {
      throw new Error(`Creative capability ${id} has invalid or duplicate CLI surface: ${cliOperation}`);
    }
    cliOperations.add(cliOperation);
    if (capability.approval === 'L0' && capability.requiredScopes.includes('canvas:write')) {
      throw new Error(`Creative capability ${id} cannot declare L0 with canvas:write`);
    }
  }
  validateCreativeCapabilityHandlers(value);
  return value;
}

function readCreativeCapabilityManifest(options = {}) {
  const manifestPath = creativeCapabilityManifestPath(options);
  if (!options.disableCache && cached?.manifestPath === manifestPath) return cached;
  const buffer = fs.readFileSync(manifestPath);
  const manifest = validateCreativeCapabilityManifest(JSON.parse(buffer.toString('utf8')));
  const record = Object.freeze({
    manifestPath,
    digest: crypto.createHash('sha256').update(buffer).digest('hex'),
    schema: manifest.schema,
    version: String(manifest.version || ''),
    principles: Object.freeze({ ...manifest.principles }),
    capabilities: Object.freeze(manifest.capabilities.map((capability) => Object.freeze({
      ...capability,
      aliases: Object.freeze([...capability.aliases]),
      nodeTypes: Object.freeze([...capability.nodeTypes]),
      nodeTypeSelector: String(capability.nodeTypeSelector || ''),
      inputKinds: Object.freeze([...capability.inputKinds]),
      outputKinds: Object.freeze([...capability.outputKinds]),
      requiredScopes: Object.freeze([...capability.requiredScopes]),
      supports: Object.freeze([...capability.supports]),
      evidence: Object.freeze([...capability.evidence]),
      cli: Object.freeze({
        command: String(capability.cli.command),
        subcommand: String(capability.cli.subcommand),
      }),
    }))),
  });
  if (!options.disableCache) cached = record;
  return record;
}
function validateCreativeCapabilityGraph(value, manifest) {
  if (value?.schema !== 't8-creative-capability-graph-v1'
    || !/^[a-f0-9]{64}$/.test(String(value.aggregateDigest || ''))
    || !Array.isArray(value.capabilities)
    || !Array.isArray(value.nodes)
    || !Array.isArray(value.bindings)
    || !Array.isArray(value.runtime?.entries)) {
    throw new Error('Creative capability graph schema is invalid');
  }
  if (Number(value.counts?.unknownNodeReferences) !== 0
    || (value.gaps?.unknownNodeReferences || []).length !== 0) {
    throw new Error('Creative capability graph contains unknown canvas node references');
  }
  if (String(value.sourceDigests?.creativeCapabilityManifest || '') !== String(manifest.digest || '')) {
    throw new Error('Creative capability graph does not match the creative capability manifest');
  }
  if (!/^[a-f0-9]{64}$/.test(String(value.sourceDigests?.capabilityGraphCompiler || ''))) {
    throw new Error('Creative capability graph compiler digest is missing');
  }
  const expectedAggregateDigest = crypto.createHash('sha256')
    .update(JSON.stringify(value.sourceDigests))
    .digest('hex');
  if (expectedAggregateDigest !== value.aggregateDigest) {
    throw new Error('Creative capability graph aggregate digest is invalid');
  }
  validateNodeCoverage(value);
  validateOperationRiskContracts(value);
  validateRuntimeCompatibility(value);
  assertCapabilityCoverageReceipt(value);
  const manifestIds = manifest.capabilities.map((capability) => capability.id);
  const graphIds = value.capabilities.map((capability) => String(capability?.id || ''));
  if (manifestIds.length !== graphIds.length
    || manifestIds.some((id, index) => id !== graphIds[index])) {
    throw new Error('Creative capability graph capability index drifted from the manifest');
  }
  const knownNodeTypes = new Set(value.nodes.map((node) => String(node?.type || '')));
  for (const capability of value.capabilities) {
    if ((capability.nodeTypes || []).some((nodeType) => !knownNodeTypes.has(String(nodeType)))) {
      throw new Error(`Creative capability graph contains unknown node type for ${capability.id}`);
    }
  }
  const graphCapabilityById = new Map(value.capabilities.map((capability) => [capability.id, capability]));
  for (const capability of manifest.capabilities) {
    const graphCapability = graphCapabilityById.get(capability.id);
    if (!graphCapability
      || String(graphCapability.uiAction || '') !== capability.id
      || String(graphCapability.cli?.command || '') !== String(capability.cli?.command || '')
      || String(graphCapability.cli?.subcommand || '') !== String(capability.cli?.subcommand || '')) {
      throw new Error(`Creative capability graph action surfaces drifted for ${capability.id}`);
    }
    const expected = (capability.nodeTypes || []).map((nodeType) => String(nodeType));
    const explicit = new Set(expected);
    const selector = String(capability.nodeTypeSelector || '');
    if (selector === 'creator-visible') {
      for (const node of value.nodes) {
        const type = String(node.type);
        if (node.hidden !== true && !explicit.has(type)) {
          expected.push(type);
        }
      }
    }
    const actual = (graphCapability?.nodeTypes || []).map((nodeType) => String(nodeType));
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(`Creative capability graph node type selection drifted for ${capability.id}`);
    }
  }
  return value;
}

function readCreativeCapabilityGraph(options = {}) {
  const manifest = options.manifest || readCreativeCapabilityManifest(options);
  const graphPath = creativeCapabilityGraphPath(options);
  if (!options.disableCache
    && cachedGraph?.graphPath === graphPath
    && cachedGraph?.manifestDigest === manifest.digest) return cachedGraph;
  const buffer = fs.readFileSync(graphPath);
  const graph = validateCreativeCapabilityGraph(JSON.parse(buffer.toString('utf8')), manifest);
  const record = Object.freeze({
    ...graph,
    graphPath,
    manifestDigest: manifest.digest,
    artifactDigest: crypto.createHash('sha256').update(buffer).digest('hex'),
  });
  if (!options.disableCache) cachedGraph = record;
  return record;
}

function publicCreativeCapabilityGraph(options = {}) {
  const graph = readCreativeCapabilityGraph(options);
  const category = String(options.category || '').trim().toLowerCase();
  const readiness = runtimeReadinessView(graph, options);
  const { graphPath: _graphPath, ...publicGraph } = graph;
  return {
    ...publicGraph,
    nodes: graph.nodes.filter((node) => !category || String(node.category).toLowerCase() === category),
    runtime: {
      ...graph.runtime,
      entries: readiness.entries,
    },
    readinessSummary: readiness.summary,
  };
}

function publicCreativeCapabilities(options = {}) {
  const manifest = readCreativeCapabilityManifest(options);
  const graph = readCreativeCapabilityGraph({ ...options, manifest });
  const readiness = runtimeReadinessView(graph, options);
  const graphCapabilityById = new Map(graph.capabilities.map((capability) => [capability.id, capability]));
  const category = String(options.category || '').trim().toLowerCase();
  const query = String(options.query || '').trim().toLowerCase();
  const capabilities = manifest.capabilities.filter((capability) => {
    if (category && capability.category.toLowerCase() !== category) return false;
    if (!query) return true;
    return [
      capability.id,
      capability.creatorLabel,
      capability.summary,
      ...capability.aliases,
    ].some((value) => String(value).toLowerCase().includes(query));
  });
  return {
    schema: manifest.schema,
    version: manifest.version,
    digest: manifest.digest,
    principles: { ...manifest.principles },
    capabilityGraph: {
      schema: graph.schema,
      aggregateDigest: graph.aggregateDigest,
      artifactDigest: graph.artifactDigest,
      counts: { ...graph.counts },
      readinessSummary: readiness.summary,
    },
    capabilities: capabilities.map((capability) => ({
      ...capability,
      cli: { ...capability.cli },
      uiAction: String(graphCapabilityById.get(capability.id)?.uiAction || capability.id),
      aliases: [...capability.aliases],
      nodeTypes: [...(graphCapabilityById.get(capability.id)?.nodeTypes || capability.nodeTypes)],
      inputKinds: [...capability.inputKinds],
      outputKinds: [...capability.outputKinds],
      requiredScopes: [...capability.requiredScopes],
      supports: [...capability.supports],
      operations: (graphCapabilityById.get(capability.id)?.operations || []).map((operation) => ({ ...operation })),
      evidence: [...capability.evidence],
    })),
  };
}

module.exports = {
  APPROVAL_LEVELS,
  CAPABILITY_ID_RE,
  CAPABILITY_SCHEMA,
  creativeCapabilityManifestPath,
  creativeCapabilityGraphPath,
  publicCreativeCapabilities,
  publicCreativeCapabilityGraph,
  readCreativeCapabilityManifest,
  readCreativeCapabilityGraph,
  runtimeReadiness,
  runtimeReadinessView,
  validateCreativeCapabilityManifest,
  validateCreativeCapabilityGraph,
};
