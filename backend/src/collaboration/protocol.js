const crypto = require('crypto');

const CANVAS_SCHEMA = 't8-canvas-document';
const CANVAS_SCHEMA_VERSION = 2;
const DEFAULT_PROJECT_ID = 'project-local';
const MAX_CANVAS_COORDINATE = 10_000_000;
const MAX_CANVAS_ZOOM = 64;

const OPERATION_TYPES = new Set([
  'node.add',
  'node.patch',
  'node.move',
  'node.delete',
  'node.restore',
  'edge.add',
  'edge.delete',
  'edge.restore',
  'viewport.set',
]);
const OPERATION_PAYLOAD_KEYS = Object.freeze({
  'node.add': Object.freeze(['node']),
  'node.patch': Object.freeze(['nodeId', 'patch', 'dataPatch', 'unsetKeys', 'dataUnsetKeys']),
  'node.move': Object.freeze(['nodeId', 'position']),
  'node.delete': Object.freeze(['nodeId']),
  'node.restore': Object.freeze(['node']),
  'edge.add': Object.freeze(['edge']),
  'edge.delete': Object.freeze(['edgeId']),
  'edge.restore': Object.freeze(['edge']),
  'viewport.set': Object.freeze(['viewport']),
});

function cloneJson(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ''));
}

function stableEntityUuid(...parts) {
  const hash = crypto.createHash('sha256').update(parts.map((part) => String(part ?? '')).join('\u001f')).digest();
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function entityUuid(value, ...fallbackParts) {
  return isUuid(value) ? String(value).toLowerCase() : stableEntityUuid(...fallbackParts);
}

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeViewport(value) {
  return {
    x: finiteNumber(value?.x),
    y: finiteNumber(value?.y),
    zoom: Math.max(0.01, finiteNumber(value?.zoom, 1)),
  };
}

function normalizeTombstoneMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).flatMap(([id, record]) => {
    if (!id || !record || typeof record !== 'object' || Array.isArray(record)) return [];
    return [[id, {
      opId: String(record.opId || ''),
      actorId: String(record.actorId || 'unknown'),
      sessionId: String(record.sessionId || 'unknown'),
      deletedAt: Math.max(1, Math.trunc(finiteNumber(record.deletedAt, Date.now()))),
      revision: Math.max(0, Math.trunc(finiteNumber(record.revision, 0))),
      entityUid: isUuid(record.entityUid) ? String(record.entityUid).toLowerCase() : null,
      entityType: record.entityType == null ? null : String(record.entityType),
      source: record.source == null ? null : String(record.source),
      target: record.target == null ? null : String(record.target),
    }]];
  }));
}

function normalizeTombstones(value) {
  return {
    nodes: normalizeTombstoneMap(value?.nodes),
    edges: normalizeTombstoneMap(value?.edges),
  };
}

function normalizeCanvasDocument(canvasId, input, options = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const projectId = String(options.projectId || source.projectId || DEFAULT_PROJECT_ID);
  const normalizedCanvasId = String(canvasId);
  const revision = Math.max(1, Math.trunc(finiteNumber(options.revision ?? source.revision, 1)));
  const nodes = Array.isArray(source.nodes) ? cloneJson(source.nodes).map((node, index) => ({
    ...node,
    entityUid: entityUuid(node?.entityUid, projectId, normalizedCanvasId, 'node', node?.id || index),
  })) : [];
  const edges = Array.isArray(source.edges) ? cloneJson(source.edges).map((edge, index) => ({
    ...edge,
    entityUid: entityUuid(edge?.entityUid, projectId, normalizedCanvasId, 'edge', edge?.id || index),
  })) : [];
  const subflowInstances = Array.isArray(source.subflowInstances) ? cloneJson(source.subflowInstances).map((instance, index) => ({
    ...instance,
    entityUid: entityUuid(instance?.entityUid, projectId, normalizedCanvasId, 'subflow-instance', instance?.instanceId || index),
  })) : [];
  return {
    ...cloneJson(source),
    schema: CANVAS_SCHEMA,
    schemaVersion: CANVAS_SCHEMA_VERSION,
    projectId,
    canvasId: normalizedCanvasId,
    entityUid: entityUuid(source.entityUid, projectId, normalizedCanvasId, 'canvas'),
    revision,
    nodes,
    edges,
    viewport: normalizeViewport(source.viewport),
    subflowInstances,
    tombstones: normalizeTombstones(source.tombstones),
    updatedAt: Math.max(1, Math.trunc(finiteNumber(options.updatedAt ?? source.updatedAt, Date.now()))),
  };
}

function normalizeOperationPayload(type, rawPayload) {
  if (rawPayload == null) return {};
  if (!rawPayload || typeof rawPayload !== 'object' || Array.isArray(rawPayload) || Buffer.isBuffer(rawPayload)) {
    throw new Error(`${type}.payload 必须是对象`);
  }
  const allowedKeys = OPERATION_PAYLOAD_KEYS[type] || [];
  const allowed = new Set(allowedKeys);
  const unknownKeys = Object.keys(rawPayload).filter((key) => !allowed.has(key));
  if (unknownKeys.length > 0) {
    throw new Error(`${type}.payload 包含不支持字段: ${unknownKeys.slice(0, 5).join(', ')}`);
  }
  const payload = {};
  for (const key of allowedKeys) {
    if (Object.prototype.hasOwnProperty.call(rawPayload, key)) payload[key] = cloneJson(rawPayload[key]);
  }
  return payload;
}

function validateOperation(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('operation 必须是对象');
  const type = String(raw.type || '');
  if (!OPERATION_TYPES.has(type)) throw new Error(`不支持的 operation: ${type || '(empty)'}`);
  const payload = normalizeOperationPayload(type, raw.payload);
  return {
    opId: String(raw.opId || crypto.randomUUID()),
    projectId: raw.projectId == null ? null : String(raw.projectId),
    canvasId: raw.canvasId == null ? null : String(raw.canvasId),
    actorId: String(raw.actorId || 'local-owner'),
    sessionId: String(raw.sessionId || 'local-session'),
    baseRevision: raw.baseRevision == null ? null : Math.max(0, Math.trunc(finiteNumber(raw.baseRevision, 0))),
    clientSeq: Math.max(0, Math.trunc(finiteNumber(raw.clientSeq, 0))),
    type,
    payload,
    timestamp: Math.max(1, Math.trunc(finiteNumber(raw.timestamp, Date.now()))),
  };
}

function operationRevisionError(code, message) {
  const error = new Error(message);
  error.code = code;
  error.status = 400;
  return error;
}

function requireOperationBatchRevision(rawBaseRevision, rawOperations) {
  if (!Number.isInteger(rawBaseRevision) || rawBaseRevision < 1) {
    throw operationRevisionError(
      'canvas_operation_revision_required',
      '协作画布操作必须提供正整数 baseRevision',
    );
  }
  for (const rawOperation of Array.isArray(rawOperations) ? rawOperations : []) {
    if (!rawOperation || typeof rawOperation !== 'object'
      || !Object.prototype.hasOwnProperty.call(rawOperation, 'baseRevision')) continue;
    if (rawOperation.baseRevision !== rawBaseRevision) {
      throw operationRevisionError(
        'canvas_operation_revision_mismatch',
        '单条 operation.baseRevision 必须与批次 baseRevision 一致',
      );
    }
  }
  return rawBaseRevision;
}

function makeTombstone(operation, revision, identity = {}) {
  return {
    opId: operation.opId,
    actorId: operation.actorId,
    sessionId: operation.sessionId,
    deletedAt: operation.timestamp,
    revision: Math.max(0, Math.trunc(finiteNumber(revision, 0))),
    entityUid: isUuid(identity.entityUid) ? String(identity.entityUid).toLowerCase() : null,
    entityType: identity.entityType == null ? null : String(identity.entityType),
    source: identity.source == null ? null : String(identity.source),
    target: identity.target == null ? null : String(identity.target),
  };
}

function deletedObjectError(kind, id) {
  const error = new Error(`${kind === 'node' ? '节点' : '连线'}已删除，必须显式恢复后才能修改: ${id}`);
  error.code = 'object_deleted';
  error.objectType = kind;
  error.objectId = id;
  return error;
}

function nodeIndex(document, nodeId) {
  const identity = String(nodeId || '');
  return document.nodes.findIndex((node) => String(node?.id || '') === identity || String(node?.entityUid || '') === identity);
}

function edgeIndex(document, edgeId) {
  const identity = String(edgeId || '');
  return document.edges.findIndex((edge) => String(edge?.id || '') === identity || String(edge?.entityUid || '') === identity);
}

function tombstoneEntry(records, identity) {
  const value = String(identity || '');
  if (!value) return null;
  if (Object.prototype.hasOwnProperty.call(records, value)) return { key: value, record: records[value] };
  const entry = Object.entries(records).find(([, record]) => String(record?.entityUid || '') === value);
  return entry ? { key: entry[0], record: entry[1] } : null;
}

function nodeMatchesIdentity(document, storedIdentity, node) {
  const value = String(storedIdentity || '');
  if (!value || !node) return false;
  if (value === String(node.id || '') || value === String(node.entityUid || '')) return true;
  const resolvedIndex = nodeIndex(document, value);
  return resolvedIndex >= 0 && document.nodes[resolvedIndex] === node;
}

const PROTECTED_NODE_PATCH_KEYS = new Set(['id', 'entityUid', 'type']);
const UNSAFE_OBJECT_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function assertSafeEntityIdentity(value, label) {
  const identity = String(value || '');
  if (!identity || identity.length > 240 || /[\u0000-\u001f\u007f]/.test(identity) || UNSAFE_OBJECT_KEYS.has(identity)) {
    throw new Error(`${label} 无效`);
  }
  return identity;
}

function ownEnumerableKeys(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value) : [];
}

function assertSafePatchKey(value, label, protectedKeys = null) {
  if (typeof value !== 'string') throw new Error(`${label} 包含无效字段`);
  const key = value;
  if (!key || key.length > 160 || /[\u0000-\u001f\u007f]/.test(key) || UNSAFE_OBJECT_KEYS.has(key)) {
    throw new Error(`${label} 包含无效字段`);
  }
  if (protectedKeys?.has(key)) throw new Error(`node.patch 禁止修改 ${key}`);
  return key;
}

function normalizeUnsetKeys(value, label, protectedKeys = null) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 500) throw new Error(`${label} 必须是最多 500 项的数组`);
  const seen = new Set();
  const result = [];
  for (const raw of value) {
    const key = assertSafePatchKey(raw, label, protectedKeys);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(key);
  }
  return result;
}

function assertPatchObjectKeys(value, label, protectedKeys = null) {
  for (const key of ownEnumerableKeys(value)) assertSafePatchKey(key, label, protectedKeys);
}

function assertBoundedFiniteNumber(value, label, minimum, maximum) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${label} 无效`);
  }
  return value;
}

function assertPosition(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} 无效`);
  const keys = Object.keys(value);
  if (keys.some((key) => !['x', 'y'].includes(key))) throw new Error(`${label} 包含无效字段`);
  return {
    x: assertBoundedFiniteNumber(value.x, `${label}.x`, -MAX_CANVAS_COORDINATE, MAX_CANVAS_COORDINATE),
    y: assertBoundedFiniteNumber(value.y, `${label}.y`, -MAX_CANVAS_COORDINATE, MAX_CANVAS_COORDINATE),
  };
}

function assertViewport(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('viewport 无效');
  const keys = Object.keys(value);
  if (keys.some((key) => !['x', 'y', 'zoom'].includes(key))) throw new Error('viewport 包含无效字段');
  return {
    x: assertBoundedFiniteNumber(value.x, 'viewport.x', -MAX_CANVAS_COORDINATE, MAX_CANVAS_COORDINATE),
    y: assertBoundedFiniteNumber(value.y, 'viewport.y', -MAX_CANVAS_COORDINATE, MAX_CANVAS_COORDINATE),
    zoom: assertBoundedFiniteNumber(value.zoom, 'viewport.zoom', 0.01, MAX_CANVAS_ZOOM),
  };
}

function assertOptionalEntityType(value, label) {
  if (value == null) return null;
  if (typeof value !== 'string' || !value.trim() || value.length > 160
    || /[\u0000-\u001f\u007f]/.test(value) || UNSAFE_OBJECT_KEYS.has(value)) {
    throw new Error(`${label} 无效`);
  }
  return value;
}

function assertCanvasDocumentInvariants(document) {
  if (!document || typeof document !== 'object' || Array.isArray(document)) throw new Error('画布结构无效');
  if (!Array.isArray(document.nodes) || !Array.isArray(document.edges)) throw new Error('画布 nodes/edges 结构无效');
  const nodeIdentities = new Map();
  for (const node of document.nodes) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) throw new Error('画布节点结构无效');
    if (typeof node.id !== 'string') throw new Error('画布节点 id 无效');
    const id = assertSafeEntityIdentity(node.id, '画布节点 id');
    if (!isUuid(node.entityUid)) throw new Error(`画布节点 entityUid 无效: ${id}`);
    assertOptionalEntityType(node.type, `画布节点 type: ${id}`);
    if (Object.prototype.hasOwnProperty.call(node, 'position')) assertPosition(node.position, `画布节点 position: ${id}`);
    if (Object.prototype.hasOwnProperty.call(node, 'data')
      && (!node.data || typeof node.data !== 'object' || Array.isArray(node.data))) {
      throw new Error(`画布节点 data 无效: ${id}`);
    }
    for (const identity of [id, String(node.entityUid).toLowerCase()]) {
      if (nodeIdentities.has(identity)) throw new Error(`画布节点身份重复: ${identity}`);
      nodeIdentities.set(identity, node);
    }
  }
  const edgeIdentities = new Set();
  for (const edge of document.edges) {
    if (!edge || typeof edge !== 'object' || Array.isArray(edge)) throw new Error('画布连线结构无效');
    if (typeof edge.id !== 'string') throw new Error('画布连线 id 无效');
    const id = assertSafeEntityIdentity(edge.id, '画布连线 id');
    if (!isUuid(edge.entityUid)) throw new Error(`画布连线 entityUid 无效: ${id}`);
    const source = assertSafeEntityIdentity(edge.source, `画布连线 source: ${id}`);
    const target = assertSafeEntityIdentity(edge.target, `画布连线 target: ${id}`);
    assertOptionalEntityType(edge.type, `画布连线 type: ${id}`);
    for (const identity of [id, String(edge.entityUid).toLowerCase()]) {
      if (edgeIdentities.has(identity)) throw new Error(`画布连线身份重复: ${identity}`);
      edgeIdentities.add(identity);
    }
    if (!nodeIdentities.has(source) || !nodeIdentities.has(target)) {
      throw new Error(`画布连线 source/target 端点不存在: ${id}`);
    }
  }
  assertViewport(document.viewport);
  return true;
}

function applyCanvasOperationInternal(inputDocument, rawOperation, deferInvariantValidation) {
  const document = normalizeCanvasDocument(inputDocument?.canvasId || 'unknown', inputDocument);
  const operation = validateOperation(rawOperation);
  const payload = operation.payload;

  if (operation.projectId && operation.projectId !== document.projectId) throw new Error('operation.projectId 与画布不一致');
  if (operation.canvasId && operation.canvasId !== document.canvasId) throw new Error('operation.canvasId 与画布不一致');
  if (operation.baseRevision != null && operation.baseRevision > document.revision) throw new Error('operation.baseRevision 超过当前画布版本');

  if (operation.type === 'node.add') {
    const node = cloneJson(payload.node);
    if (!node || typeof node !== 'object' || !String(node.id || '')) throw new Error('node.add 缺少 node.id');
    node.id = assertSafeEntityIdentity(node.id, 'node.add node.id');
    node.entityUid = entityUuid(node.entityUid, document.projectId, document.canvasId, 'node', node.id);
    if (tombstoneEntry(document.tombstones.nodes, node.id) || tombstoneEntry(document.tombstones.nodes, node.entityUid)) {
      throw deletedObjectError('node', node.id);
    }
    if (nodeIndex(document, node.id) >= 0 || nodeIndex(document, node.entityUid) >= 0) throw new Error(`节点已存在: ${node.id}`);
    assertOptionalEntityType(node.type, 'node.add node.type');
    if (node.type == null) throw new Error('node.add 缺少 node.type');
    node.position = assertPosition(node.position, 'node.add node.position');
    document.nodes.push(node);
  } else if (operation.type === 'node.patch') {
    payload.nodeId = assertSafeEntityIdentity(payload.nodeId, 'node.patch nodeId');
    if (tombstoneEntry(document.tombstones.nodes, payload.nodeId)) throw deletedObjectError('node', payload.nodeId);
    const index = nodeIndex(document, payload.nodeId);
    if (index < 0) throw new Error(`节点不存在: ${payload.nodeId}`);
    const current = document.nodes[index];
    if (payload.patch != null && (!payload.patch || typeof payload.patch !== 'object' || Array.isArray(payload.patch))) {
      throw new Error('node.patch.patch 必须是对象');
    }
    if (payload.dataPatch != null && (!payload.dataPatch || typeof payload.dataPatch !== 'object' || Array.isArray(payload.dataPatch))) {
      throw new Error('node.patch.dataPatch 必须是对象');
    }
    const patch = payload.patch ? cloneJson(payload.patch) : {};
    const dataPatch = payload.dataPatch ? cloneJson(payload.dataPatch) : null;
    assertPatchObjectKeys(patch, 'node.patch.patch', PROTECTED_NODE_PATCH_KEYS);
    assertPatchObjectKeys(dataPatch, 'node.patch.dataPatch');
    if (patch.data && typeof patch.data === 'object' && !Array.isArray(patch.data)) {
      assertPatchObjectKeys(patch.data, 'node.patch.patch.data');
    }
    const unsetKeys = normalizeUnsetKeys(payload.unsetKeys, 'node.patch.unsetKeys', PROTECTED_NODE_PATCH_KEYS);
    const dataUnsetKeys = normalizeUnsetKeys(payload.dataUnsetKeys, 'node.patch.dataUnsetKeys');
    const next = {
      ...current,
      ...patch,
      id: current.id,
      entityUid: current.entityUid,
      type: current.type,
    };
    if (dataPatch) {
      const baseData = patch.data && typeof patch.data === 'object' && !Array.isArray(patch.data)
        ? patch.data
        : (current.data && typeof current.data === 'object' && !Array.isArray(current.data) ? current.data : {});
      next.data = { ...baseData, ...dataPatch };
    }
    for (const key of unsetKeys) delete next[key];
    if (dataUnsetKeys.length) {
      const nextData = next.data && typeof next.data === 'object' && !Array.isArray(next.data) ? { ...next.data } : {};
      for (const key of dataUnsetKeys) delete nextData[key];
      next.data = nextData;
    }
    document.nodes[index] = next;
  } else if (operation.type === 'node.move') {
    payload.nodeId = assertSafeEntityIdentity(payload.nodeId, 'node.move nodeId');
    if (tombstoneEntry(document.tombstones.nodes, payload.nodeId)) throw deletedObjectError('node', payload.nodeId);
    const index = nodeIndex(document, payload.nodeId);
    if (index < 0) throw new Error(`节点不存在: ${payload.nodeId}`);
    const position = assertPosition(payload.position, 'node.move position');
    document.nodes[index] = {
      ...document.nodes[index],
      position,
    };
  } else if (operation.type === 'node.delete') {
    const id = assertSafeEntityIdentity(payload.nodeId, 'node.delete nodeId');
    const index = nodeIndex(document, id);
    const existingNode = index >= 0 ? document.nodes[index] : null;
    if (!existingNode) {
      if (tombstoneEntry(document.tombstones.nodes, id)) throw deletedObjectError('node', id);
      throw new Error(`节点不存在: ${id}`);
    }
    const canonicalId = String(existingNode?.id || id);
    const connectedEdges = document.edges.filter((edge) => (
      nodeMatchesIdentity(document, edge?.source, existingNode)
      || nodeMatchesIdentity(document, edge?.target, existingNode)
    ));
    document.tombstones.nodes[canonicalId] = makeTombstone(operation, document.revision + 1, {
      entityUid: existingNode?.entityUid,
      entityType: existingNode?.type,
    });
    for (const edge of connectedEdges) {
      if (edge?.id) document.tombstones.edges[String(edge.id)] = makeTombstone(operation, document.revision + 1, {
        entityUid: edge.entityUid,
        entityType: edge.type,
        source: edge.source,
        target: edge.target,
      });
    }
    document.nodes = document.nodes.filter((node) => String(node?.id || '') !== canonicalId);
    const connectedEdgeSet = new Set(connectedEdges);
    document.edges = document.edges.filter((edge) => !connectedEdgeSet.has(edge));
  } else if (operation.type === 'node.restore') {
    const node = cloneJson(payload.node);
    if (!node || typeof node !== 'object' || !String(node.id || '')) throw new Error('node.restore 缺少 node.id');
    node.id = assertSafeEntityIdentity(node.id, 'node.restore node.id');
    const deleted = tombstoneEntry(document.tombstones.nodes, node.id)
      || tombstoneEntry(document.tombstones.nodes, node.entityUid);
    if (!deleted) throw new Error(`节点没有可恢复的删除记录: ${node.id}`);
    if (String(node.id) !== String(deleted.key)) throw new Error('node.restore 必须使用删除记录中的 id');
    if (!isUuid(deleted.record.entityUid)) throw new Error('node.restore 删除记录缺少可验证 entityUid');
    if (node.entityUid != null && String(node.entityUid).toLowerCase() !== deleted.record.entityUid) {
      throw new Error('node.restore entityUid 与删除记录不一致');
    }
    const restoredType = node.type == null ? null : String(node.type);
    if (restoredType !== deleted.record.entityType) throw new Error('node.restore type 与删除记录不一致');
    node.entityUid = deleted.record.entityUid;
    if (nodeIndex(document, node.id) >= 0 || nodeIndex(document, node.entityUid) >= 0) throw new Error(`节点已存在: ${node.id}`);
    delete document.tombstones.nodes[deleted.key];
    document.nodes.push(node);
  } else if (operation.type === 'edge.add') {
    const edge = cloneJson(payload.edge);
    if (!edge || typeof edge !== 'object' || !String(edge.id || '')) throw new Error('edge.add 缺少 edge.id');
    edge.id = assertSafeEntityIdentity(edge.id, 'edge.add edge.id');
    edge.source = assertSafeEntityIdentity(edge.source, 'edge.add source');
    edge.target = assertSafeEntityIdentity(edge.target, 'edge.add target');
    edge.entityUid = entityUuid(edge.entityUid, document.projectId, document.canvasId, 'edge', edge.id);
    if (tombstoneEntry(document.tombstones.edges, edge.id) || tombstoneEntry(document.tombstones.edges, edge.entityUid)) throw deletedObjectError('edge', edge.id);
    if (edgeIndex(document, edge.id) >= 0 || edgeIndex(document, edge.entityUid) >= 0) throw new Error(`连线已存在: ${edge.id}`);
    if (tombstoneEntry(document.tombstones.nodes, edge.source)) throw deletedObjectError('node', edge.source);
    if (tombstoneEntry(document.tombstones.nodes, edge.target)) throw deletedObjectError('node', edge.target);
    if (nodeIndex(document, edge.source) < 0 || nodeIndex(document, edge.target) < 0) {
      throw new Error('edge.add 的 source/target 节点不存在');
    }
    document.edges.push(edge);
  } else if (operation.type === 'edge.delete') {
    const id = assertSafeEntityIdentity(payload.edgeId, 'edge.delete edgeId');
    const index = edgeIndex(document, id);
    const existingEdge = index >= 0 ? document.edges[index] : null;
    if (!existingEdge) {
      if (tombstoneEntry(document.tombstones.edges, id)) throw deletedObjectError('edge', id);
      throw new Error(`连线不存在: ${id}`);
    }
    const canonicalId = String(existingEdge?.id || id);
    document.tombstones.edges[canonicalId] = makeTombstone(operation, document.revision + 1, {
      entityUid: existingEdge?.entityUid,
      entityType: existingEdge?.type,
      source: existingEdge?.source,
      target: existingEdge?.target,
    });
    document.edges = document.edges.filter((edge) => String(edge?.id || '') !== canonicalId);
  } else if (operation.type === 'edge.restore') {
    const edge = cloneJson(payload.edge);
    if (!edge || typeof edge !== 'object' || !String(edge.id || '')) throw new Error('edge.restore 缺少 edge.id');
    edge.id = assertSafeEntityIdentity(edge.id, 'edge.restore edge.id');
    edge.source = assertSafeEntityIdentity(edge.source, 'edge.restore source');
    edge.target = assertSafeEntityIdentity(edge.target, 'edge.restore target');
    const deleted = tombstoneEntry(document.tombstones.edges, edge.id)
      || tombstoneEntry(document.tombstones.edges, edge.entityUid);
    if (!deleted) throw new Error(`连线没有可恢复的删除记录: ${edge.id}`);
    if (String(edge.id) !== String(deleted.key)) throw new Error('edge.restore 必须使用删除记录中的 id');
    if (!isUuid(deleted.record.entityUid)) throw new Error('edge.restore 删除记录缺少可验证 entityUid');
    if (edge.entityUid != null && String(edge.entityUid).toLowerCase() !== deleted.record.entityUid) {
      throw new Error('edge.restore entityUid 与删除记录不一致');
    }
    const restoredType = edge.type == null ? null : String(edge.type);
    if (restoredType !== deleted.record.entityType) throw new Error('edge.restore type 与删除记录不一致');
    if (edge.source !== deleted.record.source || edge.target !== deleted.record.target) {
      throw new Error('edge.restore source/target 与删除记录不一致');
    }
    edge.entityUid = deleted.record.entityUid;
    if (edgeIndex(document, edge.id) >= 0 || edgeIndex(document, edge.entityUid) >= 0) throw new Error(`连线已存在: ${edge.id}`);
    if (nodeIndex(document, edge.source) < 0 || nodeIndex(document, edge.target) < 0) throw new Error('edge.restore 的 source/target 节点不存在');
    delete document.tombstones.edges[deleted.key];
    document.edges.push(edge);
  } else if (operation.type === 'viewport.set') {
    document.viewport = assertViewport(payload.viewport);
  }

  const normalized = normalizeCanvasDocument(document.canvasId, document, {
    projectId: document.projectId,
    revision: document.revision,
    updatedAt: Date.now(),
  });
  if (!deferInvariantValidation) assertCanvasDocumentInvariants(normalized);
  return { document: normalized, operation };
}

function applyCanvasOperation(inputDocument, rawOperation) {
  return applyCanvasOperationInternal(inputDocument, rawOperation, false);
}

/**
 * Read-only planning helper. It preserves the exact operation/tombstone/collision
 * semantics while allowing a multi-operation repair to pass through an invalid
 * intermediate graph. Callers must validate the final document before using it.
 */
function applyCanvasOperationForSimulation(inputDocument, rawOperation) {
  return applyCanvasOperationInternal(inputDocument, rawOperation, true);
}

module.exports = {
  CANVAS_SCHEMA,
  CANVAS_SCHEMA_VERSION,
  DEFAULT_PROJECT_ID,
  OPERATION_PAYLOAD_KEYS,
  OPERATION_TYPES,
  normalizeCanvasDocument,
  validateOperation,
  requireOperationBatchRevision,
  applyCanvasOperation,
  applyCanvasOperationForSimulation,
  assertCanvasDocumentInvariants,
  normalizeTombstones,
  isUuid,
  stableEntityUuid,
};
