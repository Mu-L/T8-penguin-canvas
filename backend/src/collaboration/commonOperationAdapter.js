const {
  applyCanvasOperation,
  normalizeCanvasDocument,
} = require('./protocol');
const { normalizeCommonOperationBatch } = require('./commonOperationProtocol');

const COMMON_GRAPH_OPERATION_TYPES = new Set([
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

class CommonOperationAdapterError extends Error {
  constructor(code, message, details = {}, status = 409) {
    super(message);
    this.name = 'CommonOperationAdapterError';
    this.code = code;
    this.details = details;
    this.status = status;
    if (code === 'common_operation_revision_conflict'
      && Number.isSafeInteger(Number(details.currentRevision))) {
      this.currentRevision = Number(details.currentRevision);
    }
  }
}

function fail(code, message, details = {}, status = 409) {
  throw new CommonOperationAdapterError(code, message, details, status);
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function byEntityUid(items, entityUid, kind) {
  const matches = (Array.isArray(items) ? items : []).filter((item) => (
    String(item?.entityUid || '').toLowerCase() === entityUid
  ));
  if (matches.length > 1) fail('common_operation_identity_ambiguous', `${kind} 身份不唯一`, { kind, entityUid });
  return matches[0] || null;
}

function tombstoneByEntityUid(records, entityUid, kind) {
  const matches = Object.entries(records && typeof records === 'object' ? records : {})
    .filter(([, record]) => String(record?.entityUid || '').toLowerCase() === entityUid);
  if (matches.length > 1) fail('common_operation_identity_ambiguous', `${kind} tombstone 身份不唯一`, { kind, entityUid });
  return matches[0] ? { displayId: matches[0][0], record: matches[0][1] } : null;
}

function exactRevision(actual, expected, kind, entityUid) {
  if (!Number.isSafeInteger(actual) || actual < 1 || actual !== expected) {
    fail('common_operation_cas_conflict', `${kind} revision 已变化`, {
      kind,
      entityUid,
      expectedRevision: expected,
      currentRevision: Number.isSafeInteger(actual) ? actual : null,
    });
  }
}

function assertAbsent(document, kind, entityUid, displayId) {
  const active = kind === 'node' ? document.nodes : document.edges;
  const deleted = kind === 'node' ? document.tombstones?.nodes : document.tombstones?.edges;
  if (byEntityUid(active, entityUid, kind) || tombstoneByEntityUid(deleted, entityUid, kind)
    || active.some((item) => String(item?.id || '') === displayId)
    || Object.prototype.hasOwnProperty.call(deleted || {}, displayId)) {
    fail('common_operation_cas_conflict', `${kind} 已存在或已删除，不能隐式复活`, { kind, entityUid, displayId });
  }
}

function requiredActive(document, kind, entityUid, expectedRevision) {
  const deleted = kind === 'node' ? document.tombstones?.nodes : document.tombstones?.edges;
  if (tombstoneByEntityUid(deleted, entityUid, kind)) {
    fail('common_operation_target_deleted', `${kind} 已删除`, { kind, entityUid });
  }
  const entity = byEntityUid(kind === 'node' ? document.nodes : document.edges, entityUid, kind);
  if (!entity) fail('common_operation_target_missing', `${kind} 不存在`, { kind, entityUid }, 404);
  exactRevision(Number(entity.entityRevision), expectedRevision, kind, entityUid);
  return entity;
}

function requiredTombstone(document, kind, entityUid, expectedRevision) {
  const active = byEntityUid(kind === 'node' ? document.nodes : document.edges, entityUid, kind);
  if (active) fail('common_operation_cas_conflict', `${kind} 已处于活动状态`, { kind, entityUid });
  const deleted = tombstoneByEntityUid(
    kind === 'node' ? document.tombstones?.nodes : document.tombstones?.edges,
    entityUid,
    kind,
  );
  if (!deleted) fail('common_operation_target_missing', `${kind} tombstone 不存在`, { kind, entityUid }, 404);
  exactRevision(Number(deleted.record?.revision), expectedRevision, `${kind}.tombstone`, entityUid);
  return deleted;
}

function operationPayload(common, document) {
  const payload = common.payload;
  if (common.type === 'node.add') {
    assertAbsent(document, 'node', payload.nodeUid, payload.displayId);
    return { node: {
      id: payload.displayId,
      entityUid: payload.nodeUid,
      type: payload.nodeType,
      position: clone(payload.position),
      data: clone(payload.data),
    } };
  }
  if (common.type === 'node.restore') {
    const deleted = requiredTombstone(document, 'node', payload.nodeUid, payload.expectedTombstoneRevision);
    if (deleted.displayId !== payload.displayId) {
      fail('common_operation_identity_collision', 'node displayId 与 tombstone 不一致', { entityUid: payload.nodeUid });
    }
    return { node: {
      id: deleted.displayId,
      entityUid: payload.nodeUid,
      ...(Array.isArray(deleted.record?.legacyAliases)
        ? { legacyAliases: clone(deleted.record.legacyAliases) }
        : {}),
      type: payload.nodeType,
      position: clone(payload.position),
      data: clone(payload.data),
    } };
  }
  if (common.type === 'node.patch') {
    const node = requiredActive(document, 'node', payload.nodeUid, payload.expectedEntityRevision);
    return {
      nodeId: node.id,
      patch: clone(payload.fields),
      unsetKeys: clone(payload.unsetFields),
    };
  }
  if (common.type === 'node.move') {
    const node = requiredActive(document, 'node', payload.nodeUid, payload.expectedEntityRevision);
    return { nodeId: node.id, position: clone(payload.position) };
  }
  if (common.type === 'node.delete') {
    const node = requiredActive(document, 'node', payload.nodeUid, payload.expectedEntityRevision);
    return { nodeId: node.id };
  }
  if (common.type === 'edge.add') {
    assertAbsent(document, 'edge', payload.edgeUid, payload.displayId);
    const source = byEntityUid(document.nodes, payload.sourceNodeUid, 'node');
    const target = byEntityUid(document.nodes, payload.targetNodeUid, 'node');
    if (!source || !target) fail('common_operation_target_missing', 'edge 端点不存在', { kind: 'node' }, 404);
    return { edge: {
      id: payload.displayId,
      entityUid: payload.edgeUid,
      source: source.id,
      target: target.id,
      sourceEntityUid: payload.sourceNodeUid,
      targetEntityUid: payload.targetNodeUid,
      sourceHandle: payload.sourceHandle,
      targetHandle: payload.targetHandle,
      type: payload.edgeType,
      data: clone(payload.data),
    } };
  }
  if (common.type === 'edge.restore') {
    const deleted = requiredTombstone(document, 'edge', payload.edgeUid, payload.expectedTombstoneRevision);
    if (deleted.displayId !== payload.displayId) {
      fail('common_operation_identity_collision', 'edge displayId 与 tombstone 不一致', { entityUid: payload.edgeUid });
    }
    const source = byEntityUid(document.nodes, payload.sourceNodeUid, 'node');
    const target = byEntityUid(document.nodes, payload.targetNodeUid, 'node');
    if (!source || !target) fail('common_operation_target_missing', 'edge 恢复端点不存在', { kind: 'node' }, 404);
    if ((deleted.record?.source != null && String(deleted.record.source) !== String(source.id))
      || (deleted.record?.target != null && String(deleted.record.target) !== String(target.id))
      || (deleted.record?.sourceEntityUid != null
        && String(deleted.record.sourceEntityUid).toLowerCase() !== payload.sourceNodeUid)
      || (deleted.record?.targetEntityUid != null
        && String(deleted.record.targetEntityUid).toLowerCase() !== payload.targetNodeUid)) {
      fail('common_operation_identity_collision', 'edge 端点稳定身份与 tombstone 不一致', {
        entityUid: payload.edgeUid,
        sourceNodeUid: payload.sourceNodeUid,
        targetNodeUid: payload.targetNodeUid,
      });
    }
    return { edge: {
      id: deleted.displayId,
      entityUid: payload.edgeUid,
      ...(Array.isArray(deleted.record?.legacyAliases)
        ? { legacyAliases: clone(deleted.record.legacyAliases) }
        : {}),
      source: source.id,
      target: target.id,
      sourceEntityUid: payload.sourceNodeUid,
      targetEntityUid: payload.targetNodeUid,
      sourceHandle: payload.sourceHandle,
      targetHandle: payload.targetHandle,
      type: payload.edgeType,
      data: clone(payload.data),
    } };
  }
  if (common.type === 'edge.delete') {
    const edge = requiredActive(document, 'edge', payload.edgeUid, payload.expectedEntityRevision);
    return { edgeId: edge.id };
  }
  if (common.type === 'viewport.set') {
    exactRevision(Number(document.viewportRevision), payload.expectedViewportRevision, 'viewport', document.entityUid);
    return { viewport: clone(payload.viewport) };
  }
  fail('common_operation_domain_mismatch', `非 graph operation 不能由画布适配器执行: ${common.type}`, { type: common.type }, 400);
}

function adaptCommonGraphBatch(rawBatch, rawDocument, principal = {}) {
  const batch = normalizeCommonOperationBatch(rawBatch);
  if (batch.operations.some((operation) => !COMMON_GRAPH_OPERATION_TYPES.has(operation.type))) {
    fail('common_operation_domain_mismatch', 'graph 批次不能混入其它领域操作', {}, 400);
  }
  let working = normalizeCanvasDocument(rawDocument?.canvasId || batch.canvasId, rawDocument);
  if (working.projectId !== batch.projectId || working.canvasId !== batch.canvasId) {
    fail('common_operation_scope_mismatch', '批次 project/canvas 与权威画布不一致', {}, 403);
  }
  if (working.revision !== batch.baseRevision) {
    fail('common_operation_revision_conflict', '批次 baseRevision 已过期', {
      expectedRevision: batch.baseRevision,
      currentRevision: working.revision,
    });
  }
  const actorId = String(principal.actorId || 'local-owner');
  const sessionId = String(principal.sessionId || 'local-session');
  const timestampBase = Math.max(1, Math.trunc(Number(principal.timestamp) || Date.now()));
  const operations = [];
  batch.operations.forEach((common, index) => {
    const operation = {
      opId: common.opId,
      projectId: working.projectId,
      canvasId: working.canvasId,
      actorId,
      sessionId,
      baseRevision: batch.baseRevision,
      clientSeq: batch.clientSeq + index,
      timestamp: timestampBase + index,
      type: common.type,
      payload: operationPayload(common, working),
    };
    const applied = applyCanvasOperation(working, operation);
    working = applied.document;
    operations.push(operation);
  });
  return { batch, operations, resultingDocument: working };
}

module.exports = {
  COMMON_GRAPH_OPERATION_TYPES,
  CommonOperationAdapterError,
  adaptCommonGraphBatch,
};
