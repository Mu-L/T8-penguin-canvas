'use strict';

const crypto = require('node:crypto');

const COVERAGE_RECEIPT_SCHEMA = 't8-creative-capability-coverage-receipt-v1';
const RUNTIME_SECTIONS = Object.freeze(['llm', 'image', 'video', 'audio', 'actions']);
const APPROVAL_LEVELS = new Set(['L0', 'L1', 'L2', 'L3']);

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function sortedUnique(values) {
  return [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right));
}

function validCompatibility(value) {
  return Boolean(value)
    && value.known === true
    && value.executable === false
    && value.requiresRuntimeCheck === true
    && typeof value.available === 'boolean'
    && [true, false, null].includes(value.installed)
    && [true, false, null].includes(value.credentialReady)
    && [true, false, null].includes(value.regionReady);
}

function handlerGaps(capabilities, bindings) {
  const bindingsByCapability = new Map();
  for (const binding of bindings) {
    const capabilityId = String(binding?.capabilityId || '').trim();
    if (!bindingsByCapability.has(capabilityId)) bindingsByCapability.set(capabilityId, []);
    bindingsByCapability.get(capabilityId).push(binding);
  }
  const known = new Set(capabilities.map((capability) => String(capability?.id || '').trim()));
  const gaps = [];
  for (const capability of capabilities) {
    const id = String(capability?.id || '').trim();
    const matches = bindingsByCapability.get(id) || [];
    if (matches.length !== 1) {
      gaps.push(`${id || '(empty)'}:${matches.length === 0 ? 'missing' : 'duplicate'}`);
      continue;
    }
    const binding = matches[0];
    if (String(binding?.handler || '').trim() !== String(capability?.handler || '').trim()
      || !/^agentControl[A-Z][A-Za-z0-9]*$/.test(String(binding?.service || ''))
      || !/^[a-z][A-Za-z0-9]*$/.test(String(binding?.method || ''))
      || !String(binding?.operation || '').trim()) {
      gaps.push(`${id}:invalid-binding`);
    }
  }
  for (const capabilityId of bindingsByCapability.keys()) {
    if (!known.has(capabilityId)) gaps.push(`${capabilityId || '(empty)'}:unknown-capability`);
  }
  return sortedUnique(gaps);
}

function operationRiskGaps(capabilities) {
  const gaps = [];
  for (const capability of capabilities) {
    const id = String(capability?.id || '').trim();
    const supports = Array.isArray(capability?.supports) ? capability.supports : [];
    const operations = Array.isArray(capability?.operations) ? capability.operations : [];
    const byName = new Map(operations.map((operation) => [
      String(operation?.operation || '').trim(),
      operation,
    ]));
    for (const operationName of supports) {
      const name = String(operationName || '').trim();
      const policy = byName.get(name);
      if (!policy
        || !APPROVAL_LEVELS.has(String(policy.riskLevel || ''))
        || typeof policy.approvalRequired !== 'boolean'
        || policy.approvalRequired !== (policy.riskLevel !== 'L0')
        || !String(policy.boundary || '').trim()
        || !Array.isArray(policy.requiredScopes)) {
        gaps.push(`${id}.${name || '(empty)'}`);
      }
    }
    for (const operation of operations) {
      const name = String(operation?.operation || '').trim();
      if (!supports.includes(name)) gaps.push(`${id}.${name || '(empty)'}:undeclared`);
    }
  }
  return sortedUnique(gaps);
}

function verificationGaps(capabilities) {
  return sortedUnique(capabilities.flatMap((capability) => {
    const id = String(capability?.id || '').trim();
    const supports = Array.isArray(capability?.supports) ? capability.supports : [];
    const evidence = Array.isArray(capability?.evidence)
      ? capability.evidence.map((item) => String(item || '').trim()).filter(Boolean)
      : [];
    const verifyPolicy = (capability?.operations || [])
      .find((operation) => operation?.operation === 'verify');
    const gaps = [];
    if (!supports.includes('verify')) gaps.push(`${id}:verify-operation-missing`);
    if (evidence.length === 0) gaps.push(`${id}:evidence-missing`);
    if (!verifyPolicy
      || verifyPolicy.riskLevel !== 'L0'
      || verifyPolicy.approvalRequired !== false
      || verifyPolicy.boundary !== 'local-read') {
      gaps.push(`${id}:verify-policy-missing`);
    }
    return gaps;
  }));
}

function compatibilityGaps(runtimeEntries) {
  const seen = new Set();
  const gaps = [];
  for (const entry of runtimeEntries) {
    const id = String(entry?.id || '').trim();
    if (!id) {
      gaps.push('(empty):runtime-id-missing');
      continue;
    }
    if (seen.has(id)) gaps.push(`${id}:duplicate-runtime-id`);
    seen.add(id);
    if (!RUNTIME_SECTIONS.includes(String(entry?.catalogSection || ''))) {
      gaps.push(`${id}:catalog-section-missing`);
    }
    if (!validCompatibility(entry?.compatibility)) gaps.push(`${id}:compatibility-edge-missing`);
  }
  return sortedUnique(gaps);
}

function buildCapabilityCoverageReceipt(graph) {
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const capabilities = Array.isArray(graph?.capabilities) ? graph.capabilities : [];
  const bindings = Array.isArray(graph?.bindings) ? graph.bindings : [];
  const runtimeEntries = Array.isArray(graph?.runtime?.entries) ? graph.runtime.entries : [];
  const knownNodeTypes = new Set(nodes.map((node) => String(node?.type || '').trim()));
  const runtimeByKind = Object.fromEntries(RUNTIME_SECTIONS.map((section) => [
    section,
    runtimeEntries.filter((entry) => entry?.catalogSection === section).length,
  ]));
  const unknownNodeReferences = sortedUnique(capabilities.flatMap((capability) => (
    (capability?.nodeTypes || [])
      .filter((nodeType) => !knownNodeTypes.has(String(nodeType || '').trim()))
      .map((nodeType) => `${capability.id}->${String(nodeType || '').trim() || '(empty)'}`)
  )));
  const missingHandlers = handlerGaps(capabilities, bindings);
  const missingOperationRisk = operationRiskGaps(capabilities);
  const missingVerification = verificationGaps(capabilities);
  const missingCompatibilityEdges = compatibilityGaps(runtimeEntries);
  const gaps = {
    unknownNodeReferences,
    missingHandlers,
    missingOperationRisk,
    missingVerification,
    missingCompatibilityEdges,
  };
  const payload = {
    schema: COVERAGE_RECEIPT_SCHEMA,
    sourceDigests: {
      capabilityManifest: String(graph?.sourceDigests?.creativeCapabilityManifest || ''),
      nodeSchema: String(graph?.sourceDigests?.canvasNodeSchema || ''),
      runtimeCatalog: String(graph?.sourceDigests?.runtimeCatalogSources || ''),
      handlerBindings: String(graph?.sourceDigests?.handlerBindings || ''),
      receiptCompiler: String(graph?.sourceDigests?.coverageReceiptCompiler || ''),
    },
    inventory: {
      nodes: {
        total: nodes.length,
        executable: nodes.filter((node) => node?.executable === true).length,
        generatable: nodes.filter((node) => node?.generatable === true).length,
      },
      runtime: runtimeByKind,
      capabilities: capabilities.length,
      handlers: bindings.length,
      operations: capabilities.reduce(
        (sum, capability) => sum + (Array.isArray(capability?.operations) ? capability.operations.length : 0),
        0,
      ),
    },
    gaps,
    complete: Object.values(gaps).every((items) => items.length === 0),
  };
  return {
    ...payload,
    digest: sha256(JSON.stringify(payload)),
  };
}

function assertCapabilityCoverageReceipt(graph) {
  const expected = buildCapabilityCoverageReceipt(graph);
  const actual = graph?.coverageReceipt;
  const counts = graph?.counts || {};
  const graphCountsMatch = Number(counts.nodes) === expected.inventory.nodes.total
    && Number(counts.executableNodes) === expected.inventory.nodes.executable
    && Number(counts.generatableNodes) === expected.inventory.nodes.generatable
    && Number(counts.capabilities) === expected.inventory.capabilities
    && Number(counts.handlers) === expected.inventory.handlers
    && Number(counts.operations) === expected.inventory.operations
    && JSON.stringify(counts.runtimeByKind) === JSON.stringify(expected.inventory.runtime)
    && Number(counts.unknownNodeReferences) === 0
    && Number(counts.missingHandlers) === 0
    && Number(counts.missingOperationRisk) === 0
    && Number(counts.missingVerification) === 0
    && Number(counts.missingCompatibilityEdges) === 0;
  const graphGapsMatch = [
    'unknownNodeReferences',
    'missingHandlers',
    'missingOperationRisk',
    'missingVerification',
    'missingCompatibilityEdges',
  ].every((name) => JSON.stringify(graph?.gaps?.[name] || []) === JSON.stringify(expected.gaps[name]));
  if (!actual
    || actual.schema !== COVERAGE_RECEIPT_SCHEMA
    || actual.digest !== expected.digest
    || JSON.stringify(actual) !== JSON.stringify(expected)
    || actual.complete !== true
    || !graphCountsMatch
    || !graphGapsMatch) {
    const gaps = Object.entries(expected.gaps)
      .filter(([, items]) => items.length > 0)
      .map(([name, items]) => `${name}=${items.join(',')}`)
      .join('; ');
    throw new Error(
      `Creative capability coverage receipt is incomplete or drifted${gaps ? `: ${gaps}` : ''}`,
    );
  }
  return graph;
}

module.exports = {
  COVERAGE_RECEIPT_SCHEMA,
  RUNTIME_SECTIONS,
  assertCapabilityCoverageReceipt,
  buildCapabilityCoverageReceipt,
  validCompatibility,
};
