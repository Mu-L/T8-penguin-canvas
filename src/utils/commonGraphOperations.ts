import type { CanvasOperationType, VersionedCanvasData } from '../types/project.ts';
import { createCanvasEntityUid, isCanonicalEntityUid } from './canvasEntityIdentity.ts';
import {
  COMMON_OPERATION_BATCH_CONTRACT,
  normalizeCommonOperationBatch,
  type CommonOperationBatch,
} from './commonOperationProtocol.ts';

export interface CommonGraphDraftEnvelope {
  opId: string;
  type: CanvasOperationType;
  payload: Record<string, unknown>;
}

interface BuildCommonGraphBatchInput {
  document: VersionedCanvasData;
  batchId: string;
  clientId: string;
  clientSeq: number;
  drafts: CommonGraphDraftEnvelope[];
  createEntityUid?: () => string;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} 无效`);
  return value as Record<string, unknown>;
}

function identity(value: unknown, label: string) {
  const normalized = String(value || '');
  if (!normalized || normalized.length > 240 || /[\u0000-\u001f\u007f]/.test(normalized)) throw new Error(`${label} 无效`);
  return normalized;
}

function revision(value: unknown, label: string) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 1) throw new Error(`${label} 缺少权威 entityRevision`);
  return normalized;
}

function entityUid(value: unknown, label: string) {
  if (!isCanonicalEntityUid(value)) throw new Error(`${label} 缺少权威 UUID`);
  return value.toLowerCase();
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function buildCommonGraphBatch(input: BuildCommonGraphBatchInput): CommonOperationBatch {
  const baseRevision = revision(input.document.revision, '画布 revision');
  if (!Array.isArray(input.drafts) || input.drafts.length < 1) throw new Error('共同操作批次不能为空');
  const nextUid = input.createEntityUid || createCanvasEntityUid;
  let nodes = clone(input.document.nodes as Array<Record<string, unknown>>);
  let edges = clone(input.document.edges as Array<Record<string, unknown>>);
  const nodeTombstones = clone(input.document.tombstones.nodes) as unknown as Record<string, Record<string, unknown>>;
  const edgeTombstones = clone(input.document.tombstones.edges) as unknown as Record<string, Record<string, unknown>>;
  let viewportRevision = revision(input.document.viewportRevision, 'viewportRevision');

  const findEntity = (items: Array<Record<string, unknown>>, value: unknown, label: string) => {
    const target = identity(value, label);
    const matches = items.filter((item) => (
      item.id === target
      || item.entityUid === target
      || (Array.isArray(item.legacyAliases) && item.legacyAliases.includes(target))
    ));
    if (matches.length !== 1) throw new Error(`${label} 不存在或身份冲突`);
    return matches[0];
  };
  const tombstone = (items: Record<string, Record<string, unknown>>, displayId: unknown, uid: unknown, label: string) => {
    const id = identity(displayId, `${label}.displayId`);
    const canonical = entityUid(uid, `${label}.entityUid`);
    const matches = Object.entries(items).filter(([key, item]) => key === id || item.entityUid === canonical);
    if (matches.length !== 1 || matches[0][0] !== id || matches[0][1].entityUid !== canonical) {
      throw new Error(`${label} tombstone 不存在或身份冲突`);
    }
    return { id, record: matches[0][1] };
  };
  const assertTombstoneAbsent = (
    items: Record<string, Record<string, unknown>>,
    displayId: unknown,
    uid: unknown,
    label: string,
  ) => {
    const id = identity(displayId, `${label}.displayId`);
    const canonical = entityUid(uid, `${label}.entityUid`);
    if (Object.entries(items).some(([key, item]) => key === id || item.entityUid === canonical)) {
      throw new Error(`${label} 身份已存在或已删除`);
    }
  };
  const edgeTombstoneRecord = (
    edge: Record<string, unknown>,
    nextEntityRevision: number,
    label: string,
  ) => {
    const source = findEntity(nodes, edge.source, `${label}.source`);
    const target = findEntity(nodes, edge.target, `${label}.target`);
    return {
      entityUid: entityUid(edge.entityUid, `${label}.entityUid`),
      entityType: edge.type == null ? null : clone(edge.type),
      revision: nextEntityRevision,
      source: identity(edge.source, `${label}.source`),
      target: identity(edge.target, `${label}.target`),
      ...(Object.prototype.hasOwnProperty.call(edge, 'sourceHandle')
        ? { sourceHandle: edge.sourceHandle == null ? null : identity(edge.sourceHandle, `${label}.sourceHandle`) }
        : {}),
      ...(Object.prototype.hasOwnProperty.call(edge, 'targetHandle')
        ? { targetHandle: edge.targetHandle == null ? null : identity(edge.targetHandle, `${label}.targetHandle`) }
        : {}),
      ...(Array.isArray(edge.legacyAliases) ? { legacyAliases: clone(edge.legacyAliases) } : {}),
      sourceEntityUid: entityUid(source.entityUid, `${label}.sourceEntityUid`),
      targetEntityUid: entityUid(target.entityUid, `${label}.targetEntityUid`),
    };
  };
  const assertLifecycleState = (
    items: Array<Record<string, unknown>>,
    tombstones: Record<string, Record<string, unknown>>,
    label: string,
  ) => {
    const owners = new Map<string, unknown>();
    for (const item of items) {
      const identities = new Set([
        identity(item.id, `${label}.id`),
        entityUid(item.entityUid, `${label}.entityUid`),
        ...(Array.isArray(item.legacyAliases)
          ? item.legacyAliases.map((alias) => identity(alias, `${label}.legacyAlias`))
          : []),
      ]);
      for (const itemIdentity of identities) {
        if (owners.has(itemIdentity)) throw new Error(`${label} 活动身份冲突`);
        owners.set(itemIdentity, item);
      }
    }
    for (const [key, rawTombstone] of Object.entries(tombstones)) {
      const deleted = record(rawTombstone, `${label}.tombstone`);
      const identities = new Set([
        identity(key, `${label}.tombstone.id`),
        ...(deleted.entityUid == null ? [] : [identity(deleted.entityUid, `${label}.tombstone.entityUid`)]),
        ...(Array.isArray(deleted.legacyAliases)
          ? deleted.legacyAliases.map((alias) => identity(alias, `${label}.tombstone.legacyAlias`))
          : []),
      ]);
      for (const deletedIdentity of identities) {
        if (owners.has(deletedIdentity)) throw new Error(`${label} 活动实体与 tombstone 身份冲突`);
        owners.set(deletedIdentity, deleted);
      }
    }
  };
  assertLifecycleState(nodes, nodeTombstones, 'node');
  assertLifecycleState(edges, edgeTombstones, 'edge');

  const restoredLegacyAliases = (
    supplied: unknown,
    deleted: Record<string, unknown>,
    label: string,
  ): string[] | undefined => {
    const inherited = Array.isArray(deleted.legacyAliases)
      ? [...new Set(deleted.legacyAliases.map((alias) => identity(alias, `${label}.tombstone.legacyAlias`)))]
      : [];
    if (supplied != null) {
      if (!Array.isArray(supplied) || supplied.length > 500) throw new Error(`${label}.legacyAliases 无效`);
      const normalized = [...new Set(supplied.map((alias) => identity(alias, `${label}.legacyAlias`)))];
      const inheritedSet = new Set(inherited);
      if (normalized.length !== inherited.length || normalized.some((alias) => !inheritedSet.has(alias))) {
        throw new Error(`${label}.legacyAliases 与 tombstone 不一致`);
      }
    }
    return inherited.length > 0 ? inherited : undefined;
  };

  const operations = input.drafts.map((draft, index) => {
    const payload = record(draft.payload, `${draft.type}.payload`);
    const nextEntityRevision = baseRevision + index + 1;
    if (draft.type === 'node.add') {
      const node = record(payload.node, 'node.add.node');
      const uid = node.entityUid == null ? nextUid() : entityUid(node.entityUid, 'node.add.entityUid');
      const displayId = identity(node.id, 'node.add.id');
      if (nodes.some((item) => item.id === displayId || item.entityUid === uid)
        || Object.entries(nodeTombstones).some(([key, item]) => key === displayId || item.entityUid === uid)) {
        throw new Error('node.add 身份已存在或已删除');
      }
      const common = {
        opId: draft.opId,
        type: draft.type,
        payload: {
          nodeUid: uid,
          displayId,
          nodeType: identity(node.type, 'node.add.type'),
          position: clone(record(node.position, 'node.add.position')),
          data: clone(record(node.data || {}, 'node.add.data')),
          expectedAbsent: true,
        },
      };
      nodes.push({ ...clone(node), id: displayId, entityUid: uid, entityRevision: nextEntityRevision });
      return common;
    }
    if (draft.type === 'node.restore') {
      const node = record(payload.node, 'node.restore.node');
      const deleted = tombstone(nodeTombstones, node.id, node.entityUid, 'node.restore');
      const common = {
        opId: draft.opId,
        type: draft.type,
        payload: {
          nodeUid: entityUid(deleted.record.entityUid, 'node.restore.entityUid'),
          displayId: deleted.id,
          nodeType: identity(node.type, 'node.restore.type'),
          position: clone(record(node.position, 'node.restore.position')),
          data: clone(record(node.data || {}, 'node.restore.data')),
          expectedTombstoneRevision: revision(deleted.record.revision, 'node.restore tombstone revision'),
        },
      };
      delete nodeTombstones[deleted.id];
      const legacyAliases = restoredLegacyAliases(node.legacyAliases, deleted.record, 'node.restore');
      const restoredNode: Record<string, unknown> = {
        ...clone(node), id: deleted.id, entityUid: deleted.record.entityUid, entityRevision: nextEntityRevision,
      };
      if (legacyAliases) restoredNode.legacyAliases = legacyAliases;
      else delete restoredNode.legacyAliases;
      nodes.push(restoredNode);
      return common;
    }
    if (draft.type === 'node.patch') {
      const node = findEntity(nodes, payload.nodeId, 'node.patch.nodeId');
      const patch = payload.patch == null ? {} : clone(record(payload.patch, 'node.patch.patch'));
      const dataPatch = payload.dataPatch == null ? null : clone(record(payload.dataPatch, 'node.patch.dataPatch'));
      const unsetFields = Array.isArray(payload.unsetKeys) ? payload.unsetKeys.map((key) => identity(key, 'node.patch.unsetKey')) : [];
      const nextNode = { ...node, ...patch };
      if (dataPatch) nextNode.data = { ...record(node.data || {}, 'node.data'), ...dataPatch };
      if (Array.isArray(payload.dataUnsetKeys) && payload.dataUnsetKeys.length) {
        const data = { ...record(nextNode.data || {}, 'node.data') };
        for (const key of payload.dataUnsetKeys) delete data[identity(key, 'node.patch.dataUnsetKey')];
        nextNode.data = data;
      }
      for (const key of unsetFields) delete nextNode[key];
      nextNode.entityRevision = nextEntityRevision;
      nodes = nodes.map((item) => item === node ? nextNode : item);
      return {
        opId: draft.opId,
        type: draft.type,
        payload: {
          nodeUid: entityUid(node.entityUid, 'node.patch.entityUid'),
          expectedEntityRevision: revision(node.entityRevision, 'node.patch.entityRevision'),
          fields: patch.data == null && dataPatch == null && !Array.isArray(payload.dataUnsetKeys)
            ? patch
            : { ...patch, data: clone(record(nextNode.data || {}, 'node.patch.data')) },
          unsetFields,
        },
      };
    }
    if (draft.type === 'node.move') {
      const node = findEntity(nodes, payload.nodeId, 'node.move.nodeId');
      nodes = nodes.map((item) => item === node ? { ...item, position: clone(payload.position), entityRevision: nextEntityRevision } : item);
      return { opId: draft.opId, type: draft.type, payload: {
        nodeUid: entityUid(node.entityUid, 'node.move.entityUid'),
        expectedEntityRevision: revision(node.entityRevision, 'node.move.entityRevision'),
        position: clone(record(payload.position, 'node.move.position')),
      } };
    }
    if (draft.type === 'node.delete') {
      const node = findEntity(nodes, payload.nodeId, 'node.delete.nodeId');
      const uid = entityUid(node.entityUid, 'node.delete.entityUid');
      const displayId = identity(node.id, 'node.delete.displayId');
      assertTombstoneAbsent(nodeTombstones, displayId, uid, 'node.delete');
      const connectedEdges = edges.filter((edge) => (
        edge.source === displayId || edge.target === displayId || edge.source === uid || edge.target === uid
      ));
      nodeTombstones[displayId] = {
        entityUid: uid,
        entityType: node.type == null ? null : clone(node.type),
        revision: nextEntityRevision,
        ...(Array.isArray(node.legacyAliases) ? { legacyAliases: clone(node.legacyAliases) } : {}),
      };
      for (const edge of connectedEdges) {
        const edgeId = identity(edge.id, 'node.delete connected edge id');
        const edgeUid = entityUid(edge.entityUid, 'node.delete connected edge entityUid');
        assertTombstoneAbsent(edgeTombstones, edgeId, edgeUid, 'node.delete connected edge');
        edgeTombstones[edgeId] = edgeTombstoneRecord(edge, nextEntityRevision, 'node.delete connected edge');
      }
      nodes = nodes.filter((item) => item !== node);
      const connectedEdgeSet = new Set(connectedEdges);
      edges = edges.filter((edge) => !connectedEdgeSet.has(edge));
      return { opId: draft.opId, type: draft.type, payload: {
        nodeUid: uid,
        expectedEntityRevision: revision(node.entityRevision, 'node.delete.entityRevision'),
      } };
    }
    if (draft.type === 'edge.add') {
      const edge = record(payload.edge, 'edge.add.edge');
      const uid = edge.entityUid == null ? nextUid() : entityUid(edge.entityUid, 'edge.add.entityUid');
      const displayId = identity(edge.id, 'edge.add.id');
      if (edges.some((item) => item.id === displayId || item.entityUid === uid)
        || Object.entries(edgeTombstones).some(([key, item]) => key === displayId || item.entityUid === uid)) {
        throw new Error('edge.add 身份已存在或已删除');
      }
      const source = findEntity(nodes, edge.source, 'edge.add.source');
      const target = findEntity(nodes, edge.target, 'edge.add.target');
      const sourceEntityUid = entityUid(source.entityUid, 'edge.add.sourceEntityUid');
      const targetEntityUid = entityUid(target.entityUid, 'edge.add.targetEntityUid');
      const common = { opId: draft.opId, type: draft.type, payload: {
        edgeUid: uid,
        displayId,
        sourceNodeUid: sourceEntityUid,
        targetNodeUid: targetEntityUid,
        sourceHandle: edge.sourceHandle == null ? null : identity(edge.sourceHandle, 'edge.add.sourceHandle'),
        targetHandle: edge.targetHandle == null ? null : identity(edge.targetHandle, 'edge.add.targetHandle'),
        edgeType: identity(edge.type || 'default', 'edge.add.type'),
        data: clone(record(edge.data || {}, 'edge.add.data')),
        expectedAbsent: true,
      } };
      edges.push({
        ...clone(edge),
        id: displayId,
        entityUid: uid,
        entityRevision: nextEntityRevision,
        source: source.id,
        target: target.id,
        sourceEntityUid,
        targetEntityUid,
      });
      return common;
    }
    if (draft.type === 'edge.restore') {
      const edge = record(payload.edge, 'edge.restore.edge');
      const deleted = tombstone(edgeTombstones, edge.id, edge.entityUid, 'edge.restore');
      const source = findEntity(nodes, edge.source, 'edge.restore.source');
      const target = findEntity(nodes, edge.target, 'edge.restore.target');
      const sourceEntityUid = entityUid(source.entityUid, 'edge.restore.sourceEntityUid');
      const targetEntityUid = entityUid(target.entityUid, 'edge.restore.targetEntityUid');
      if ((deleted.record.source != null && String(deleted.record.source) !== String(source.id))
        || (deleted.record.target != null && String(deleted.record.target) !== String(target.id))
        || (deleted.record.sourceEntityUid != null
          && entityUid(deleted.record.sourceEntityUid, 'edge.restore tombstone sourceEntityUid') !== sourceEntityUid)
        || (deleted.record.targetEntityUid != null
          && entityUid(deleted.record.targetEntityUid, 'edge.restore tombstone targetEntityUid') !== targetEntityUid)) {
        throw new Error('edge.restore 稳定端点身份与 tombstone 不一致');
      }
      const common = { opId: draft.opId, type: draft.type, payload: {
        edgeUid: entityUid(deleted.record.entityUid, 'edge.restore.entityUid'),
        displayId: deleted.id,
        sourceNodeUid: sourceEntityUid,
        targetNodeUid: targetEntityUid,
        sourceHandle: edge.sourceHandle == null ? null : identity(edge.sourceHandle, 'edge.restore.sourceHandle'),
        targetHandle: edge.targetHandle == null ? null : identity(edge.targetHandle, 'edge.restore.targetHandle'),
        edgeType: identity(edge.type || 'default', 'edge.restore.type'),
        data: clone(record(edge.data || {}, 'edge.restore.data')),
        expectedTombstoneRevision: revision(deleted.record.revision, 'edge.restore tombstone revision'),
      } };
      delete edgeTombstones[deleted.id];
      const legacyAliases = restoredLegacyAliases(edge.legacyAliases, deleted.record, 'edge.restore');
      const restoredEdge: Record<string, unknown> = {
        ...clone(edge),
        id: deleted.id,
        entityUid: deleted.record.entityUid,
        entityRevision: nextEntityRevision,
        source: source.id,
        target: target.id,
        sourceEntityUid,
        targetEntityUid,
      };
      if (legacyAliases) restoredEdge.legacyAliases = legacyAliases;
      else delete restoredEdge.legacyAliases;
      edges.push(restoredEdge);
      return common;
    }
    if (draft.type === 'edge.delete') {
      const edge = findEntity(edges, payload.edgeId, 'edge.delete.edgeId');
      const uid = entityUid(edge.entityUid, 'edge.delete.entityUid');
      const displayId = identity(edge.id, 'edge.delete.displayId');
      assertTombstoneAbsent(edgeTombstones, displayId, uid, 'edge.delete');
      edgeTombstones[displayId] = edgeTombstoneRecord(edge, nextEntityRevision, 'edge.delete');
      edges = edges.filter((item) => item !== edge);
      return { opId: draft.opId, type: draft.type, payload: {
        edgeUid: uid,
        expectedEntityRevision: revision(edge.entityRevision, 'edge.delete.entityRevision'),
      } };
    }
    if (draft.type === 'viewport.set') {
      const expectedViewportRevision = viewportRevision;
      viewportRevision = nextEntityRevision;
      return { opId: draft.opId, type: draft.type, payload: {
        expectedViewportRevision,
        viewport: clone(record(payload.viewport, 'viewport.set.viewport')),
      } };
    }
    throw new Error(`共同 graph operation 不支持: ${draft.type}`);
  });

  return normalizeCommonOperationBatch({
    contractVersion: COMMON_OPERATION_BATCH_CONTRACT,
    projectId: input.document.projectId,
    canvasId: input.document.canvasId,
    baseRevision,
    batchId: input.batchId,
    clientId: input.clientId,
    clientSeq: input.clientSeq,
    operations,
  });
}
