const { exactConnectionPortsForNode } = require('./canvasAgentTools');

const STRUCTURAL_OPERATION_TYPES = new Set([
  'edge.add',
  'edge.restore',
  'node.add',
  'node.patch',
  'node.restore',
]);
const COLLABORATIVE_NODE_TEXT_FIELDS = new Set([
  'title',
  'label',
  'prompt',
  'negativePrompt',
  'notes',
  'description',
]);

const ERROR_DEFINITIONS = Object.freeze({
  endpointInvalid: Object.freeze({
    code: 'collaboration_structure_endpoint_invalid',
    status: 422,
    message: '协作结构写入包含无效连线端点',
  }),
  selfEdge: Object.freeze({
    code: 'collaboration_structure_self_edge',
    status: 422,
    message: '协作结构写入不允许节点连接到自身',
  }),
  duplicateEdge: Object.freeze({
    code: 'collaboration_structure_duplicate_edge',
    status: 409,
    message: '协作结构写入产生了重复连线',
  }),
  portContractUnresolved: Object.freeze({
    code: 'collaboration_structure_port_contract_unresolved',
    status: 422,
    message: '协作结构写入无法解析权威端口契约',
  }),
  handleUnknown: Object.freeze({
    code: 'collaboration_structure_handle_unknown',
    status: 422,
    message: '协作结构写入引用了未知端口',
  }),
  portTypeIncompatible: Object.freeze({
    code: 'collaboration_structure_port_type_incompatible',
    status: 422,
    message: '协作结构写入的端口类型不兼容',
  }),
  portCapacityExceeded: Object.freeze({
    code: 'collaboration_structure_port_capacity_exceeded',
    status: 409,
    message: '协作结构写入超过了端口连接容量',
  }),
  textFieldManaged: Object.freeze({
    code: 'collaboration_structure_text_field_managed',
    status: 422,
    message: '协作标题、Prompt 与说明字段必须通过协同文本事务修改',
  }),
});

class CollaborationStructureAuthorityError extends Error {
  constructor(definition) {
    super(definition.message);
    this.name = 'CollaborationStructureAuthorityError';
    this.code = definition.code;
    this.status = definition.status;
  }
}

function authorityError(definition) {
  return new CollaborationStructureAuthorityError(definition);
}

function asIdentity(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function normalizedHandle(value) {
  return value == null ? null : String(value);
}

function indexEntities(entities) {
  const byIdentity = new Map();
  for (const entity of entities) {
    if (!entity || typeof entity !== 'object' || Array.isArray(entity)) continue;
    const identities = [asIdentity(entity.id), asIdentity(entity.entityUid)].filter(Boolean);
    for (const identity of identities) {
      if (!byIdentity.has(identity)) byIdentity.set(identity, entity);
      else if (byIdentity.get(identity) !== entity) byIdentity.set(identity, null);
    }
  }
  return byIdentity;
}

function managedNodeTextValue(node, field) {
  const value = node?.data?.[field];
  return value === undefined ? '' : value;
}

function nodePatchTouchesManagedText(operation) {
  if (operation?.type !== 'node.patch') return false;
  const payload = operation.payload || {};
  const patchData = payload?.patch?.data;
  return [payload.dataPatch, patchData].some((value) => (
    value && typeof value === 'object' && !Array.isArray(value)
      && Object.keys(value).some((key) => COLLABORATIVE_NODE_TEXT_FIELDS.has(key))
  )) || (Array.isArray(payload.dataUnsetKeys)
    && payload.dataUnsetKeys.some((key) => COLLABORATIVE_NODE_TEXT_FIELDS.has(String(key))));
}

function assertManagedTextFieldsUnchanged(resultingDocument, operations, previousDocument) {
  const patches = operations.filter((operation) => nodePatchTouchesManagedText(operation));
  if (patches.length === 0) return;
  const previousNodes = indexEntities(Array.isArray(previousDocument?.nodes) ? previousDocument.nodes : []);
  const resultingNodes = indexEntities(Array.isArray(resultingDocument?.nodes) ? resultingDocument.nodes : []);
  for (const operation of patches) {
    const identity = asIdentity(operation?.payload?.nodeId);
    const previous = identity ? previousNodes.get(identity) : null;
    const resulting = identity ? resultingNodes.get(identity) : null;
    if (!previous || !resulting) throw authorityError(ERROR_DEFINITIONS.textFieldManaged);
    for (const field of COLLABORATIVE_NODE_TEXT_FIELDS) {
      if (managedNodeTextValue(previous, field) !== managedNodeTextValue(resulting, field)) {
        throw authorityError(ERROR_DEFINITIONS.textFieldManaged);
      }
    }
  }
}

function operationNodeIdentities(operation) {
  if (operation?.type === 'node.patch') return [asIdentity(operation?.payload?.nodeId)].filter(Boolean);
  if (operation?.type === 'node.add' || operation?.type === 'node.restore') {
    return [
      asIdentity(operation?.payload?.node?.id),
      asIdentity(operation?.payload?.node?.entityUid),
    ].filter(Boolean);
  }
  return [];
}

function operationEdgeIdentities(operation) {
  if (operation?.type !== 'edge.add' && operation?.type !== 'edge.restore') return [];
  return [
    asIdentity(operation?.payload?.edge?.id),
    asIdentity(operation?.payload?.edge?.entityUid),
  ].filter(Boolean);
}

function resolveEdgeEndpoint(edge, key, nodeByIdentity) {
  const identity = asIdentity(edge?.[key]);
  if (!identity) return null;
  return nodeByIdentity.get(identity) || null;
}

function canonicalNodeId(node) {
  return asIdentity(node?.id) || asIdentity(node?.entityUid);
}

function edgeSignature(edge, sourceNode, targetNode) {
  return JSON.stringify([
    canonicalNodeId(sourceNode),
    normalizedHandle(edge?.sourceHandle),
    canonicalNodeId(targetNode),
    normalizedHandle(edge?.targetHandle),
  ]);
}

function portCountKey(node, direction, portId) {
  return JSON.stringify([
    canonicalNodeId(node),
    direction,
    normalizedHandle(portId),
  ]);
}

function compatiblePortKinds(sourcePort, targetPort) {
  const sourceKinds = Array.isArray(sourcePort?.kinds) ? sourcePort.kinds : [];
  const targetKinds = Array.isArray(targetPort?.kinds) ? targetPort.kinds : [];
  return sourceKinds.length > 0 && targetKinds.length > 0
    && (sourceKinds.includes('any')
      || targetKinds.includes('any')
      || sourceKinds.some((kind) => targetKinds.includes(kind)));
}

function affectedFinalEdges(document, operations, nodeByIdentity, edgeByIdentity) {
  const affectedNodes = new Set();
  const affectedEdges = new Set();

  for (const operation of operations) {
    for (const identity of operationNodeIdentities(operation)) {
      const node = nodeByIdentity.get(identity);
      if (node) affectedNodes.add(node);
    }
    for (const identity of operationEdgeIdentities(operation)) {
      const edge = edgeByIdentity.get(identity);
      if (edge) affectedEdges.add(edge);
    }
  }

  if (affectedNodes.size > 0) {
    for (const edge of document.edges) {
      const sourceNode = resolveEdgeEndpoint(edge, 'source', nodeByIdentity);
      const targetNode = resolveEdgeEndpoint(edge, 'target', nodeByIdentity);
      if (affectedNodes.has(sourceNode) || affectedNodes.has(targetNode)) affectedEdges.add(edge);
    }
  }

  return { affectedEdges, affectedNodes };
}

function assertCollaborationStructureAuthority(resultingDocument, rawOperations, options = {}) {
  const operations = Array.isArray(rawOperations)
    ? rawOperations.filter((operation) => STRUCTURAL_OPERATION_TYPES.has(operation?.type))
    : [];
  if (operations.length === 0) return true;

  const document = resultingDocument && typeof resultingDocument === 'object' ? resultingDocument : {};
  assertManagedTextFieldsUnchanged(document, operations, options.previousDocument);
  const nodes = Array.isArray(document.nodes) ? document.nodes : [];
  const edges = Array.isArray(document.edges) ? document.edges : [];
  const nodeByIdentity = indexEntities(nodes);
  const edgeByIdentity = indexEntities(edges);
  const { affectedEdges } = affectedFinalEdges(
    { ...document, edges },
    operations,
    nodeByIdentity,
    edgeByIdentity,
  );

  const endpointByEdge = new Map();
  for (const edge of edges) {
    const sourceNode = resolveEdgeEndpoint(edge, 'source', nodeByIdentity);
    const targetNode = resolveEdgeEndpoint(edge, 'target', nodeByIdentity);
    if (!sourceNode || !targetNode || !canonicalNodeId(sourceNode) || !canonicalNodeId(targetNode)) {
      if (affectedEdges.has(edge)) throw authorityError(ERROR_DEFINITIONS.endpointInvalid);
      continue;
    }
    endpointByEdge.set(edge, { sourceNode, targetNode });
    if (affectedEdges.has(edge) && sourceNode === targetNode) {
      throw authorityError(ERROR_DEFINITIONS.selfEdge);
    }
  }

  const edgesBySignature = new Map();
  for (const [edge, endpoints] of endpointByEdge) {
    const signature = edgeSignature(edge, endpoints.sourceNode, endpoints.targetNode);
    if (!edgesBySignature.has(signature)) edgesBySignature.set(signature, []);
    edgesBySignature.get(signature).push(edge);
  }
  for (const duplicateEdges of edgesBySignature.values()) {
    if (duplicateEdges.length > 1 && duplicateEdges.some((edge) => affectedEdges.has(edge))) {
      throw authorityError(ERROR_DEFINITIONS.duplicateEdge);
    }
  }

  const contractsByNode = new Map();
  const exactContracts = (node) => {
    if (contractsByNode.has(node)) return contractsByNode.get(node);
    let contracts = null;
    try {
      contracts = exactConnectionPortsForNode(node, { resolveSubflow: options.resolveSubflow });
    } catch (_) {
      contracts = null;
    }
    contractsByNode.set(node, contracts);
    return contracts;
  };

  const addedOrRestoredNodes = new Set();
  for (const operation of operations) {
    if (operation?.type !== 'node.add' && operation?.type !== 'node.restore') continue;
    for (const identity of operationNodeIdentities(operation)) {
      const node = nodeByIdentity.get(identity);
      if (node) addedOrRestoredNodes.add(node);
    }
  }
  if ([...addedOrRestoredNodes].some((node) => !exactContracts(node))) {
    throw authorityError(ERROR_DEFINITIONS.portContractUnresolved);
  }
  if (affectedEdges.size === 0) return true;

  const affectedPorts = [];
  for (const edge of affectedEdges) {
    const endpoints = endpointByEdge.get(edge);
    if (!endpoints) throw authorityError(ERROR_DEFINITIONS.endpointInvalid);
    const sourceContracts = exactContracts(endpoints.sourceNode);
    const targetContracts = exactContracts(endpoints.targetNode);
    if (!sourceContracts || !targetContracts) {
      throw authorityError(ERROR_DEFINITIONS.portContractUnresolved);
    }
    const sourceHandle = normalizedHandle(edge?.sourceHandle);
    const targetHandle = normalizedHandle(edge?.targetHandle);
    const sourcePort = sourceContracts.outputs.find((port) => port.id === sourceHandle) || null;
    const targetPort = targetContracts.inputs.find((port) => port.id === targetHandle) || null;
    if (!sourcePort || !targetPort) throw authorityError(ERROR_DEFINITIONS.handleUnknown);
    if (!compatiblePortKinds(sourcePort, targetPort)) {
      throw authorityError(ERROR_DEFINITIONS.portTypeIncompatible);
    }
    affectedPorts.push(
      { node: endpoints.sourceNode, direction: 'outputs', port: sourcePort },
      { node: endpoints.targetNode, direction: 'inputs', port: targetPort },
    );
  }

  const attachedCounts = new Map();
  for (const [edge, endpoints] of endpointByEdge) {
    const sourceKey = portCountKey(endpoints.sourceNode, 'outputs', edge?.sourceHandle);
    const targetKey = portCountKey(endpoints.targetNode, 'inputs', edge?.targetHandle);
    attachedCounts.set(sourceKey, (attachedCounts.get(sourceKey) || 0) + 1);
    attachedCounts.set(targetKey, (attachedCounts.get(targetKey) || 0) + 1);
  }
  const checkedPorts = new Set();
  for (const { node, direction, port } of affectedPorts) {
    const key = portCountKey(node, direction, port.id);
    if (checkedPorts.has(key)) continue;
    checkedPorts.add(key);
    if (port.maxConnections != null && (attachedCounts.get(key) || 0) > port.maxConnections) {
      throw authorityError(ERROR_DEFINITIONS.portCapacityExceeded);
    }
  }

  return true;
}

function createCollaborationStructureAuthorityAssertion(rawOperations, options = {}) {
  const operations = Array.isArray(rawOperations) ? [...rawOperations] : [];
  return (resultingDocument) => assertCollaborationStructureAuthority(resultingDocument, operations, options);
}

module.exports = {
  CollaborationStructureAuthorityError,
  assertCollaborationStructureAuthority,
  createCollaborationStructureAuthorityAssertion,
};
