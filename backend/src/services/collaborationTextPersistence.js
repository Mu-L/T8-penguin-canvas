const crypto = require('crypto');
const Y = require('yjs');

const {
  COLLABORATION_TEXT_BINDING_CONTRACT,
  MAX_TEXT_STATE_BYTES,
  TEXT_FIELD_POLICIES,
  CollaborationTextAuthorityError,
  authorizeCollaborationTextUpdate,
} = require('./collaborationTextAuthority');

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UNSAFE_IDENTITIES = new Set(['__proto__', 'prototype', 'constructor']);
const COLLABORATION_TEXT_RECOVERY_CONTRACT = 't8-collaboration-text-recovery-v1';

class CollaborationTextPersistenceError extends Error {
  constructor(code, status, message, details = null) {
    super(message);
    this.name = 'CollaborationTextPersistenceError';
    this.code = code;
    this.status = status;
    if (details != null) this.details = details;
  }
}

function fail(code, status, message, details = null) {
  throw new CollaborationTextPersistenceError(code, status, message, details);
}

function boundedIdentity(value, label) {
  if (typeof value !== 'string' || !value || value.length > 240
    || /[\u0000-\u001f\u007f]/.test(value) || UNSAFE_IDENTITIES.has(value)) {
    fail('collaboration_text_envelope_invalid', 400, `协同文本 ${label} 无效`);
  }
  return value;
}

function canonicalUuid(value, label) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    fail('collaboration_text_envelope_invalid', 400, `协同文本 ${label} 无效`);
  }
  return value.toLowerCase();
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function parseJson(value, fallback = null) {
  try {
    return JSON.parse(value);
  } catch (_) {
    return fallback;
  }
}

function readPath(value, path) {
  let current = value;
  for (const key of path) {
    if (current == null || typeof current !== 'object') return undefined;
    current = current[key];
  }
  return current;
}

function writePath(value, path, nextValue) {
  let current = value;
  for (let index = 0; index < path.length - 1; index += 1) {
    const key = path[index];
    if (!current[key] || typeof current[key] !== 'object' || Array.isArray(current[key])) current[key] = {};
    current = current[key];
  }
  current[path[path.length - 1]] = nextValue;
}

function entityUidOf(value) {
  const candidate = String(value?.entityUid || value?.entity_uid || '');
  return UUID_PATTERN.test(candidate) ? candidate.toLowerCase() : null;
}

function tombstoneContains(document, targetType, targetEntityUid) {
  const collection = targetType === 'node'
    ? document?.tombstones?.nodes
    : targetType === 'edge'
      ? document?.tombstones?.edges
      : null;
  if (!collection || typeof collection !== 'object') return false;
  return Object.values(collection).some((entry) => entityUidOf(entry) === targetEntityUid);
}

function encodePlainTextState(materializedText) {
  const document = new Y.Doc();
  try {
    const text = document.getText('content');
    if (materializedText) text.insert(0, materializedText);
    const state = Buffer.from(Y.encodeStateAsUpdate(document));
    return {
      state,
      stateVector: Buffer.from(Y.encodeStateVector(document)),
      stateDigest: sha256(state),
      textDigest: sha256(Buffer.from(materializedText, 'utf8')),
    };
  } finally {
    document.destroy();
  }
}

function decodePlainTextState(state) {
  if (!Buffer.isBuffer(state) || state.length < 1 || state.length > MAX_TEXT_STATE_BYTES) {
    fail('collaboration_text_state_invalid', 409, '权威协同文本状态损坏或不兼容');
  }
  const document = new Y.Doc();
  try {
    Y.applyUpdate(document, state);
    const text = document.getText('content');
    const roots = [...document.share.entries()];
    if (roots.length !== 1 || roots[0][0] !== 'content' || !(roots[0][1] instanceof Y.Text)) {
      fail('collaboration_text_state_invalid', 409, '权威协同文本状态损坏或不兼容');
    }
    if (text.toDelta().some((part) => typeof part?.insert !== 'string'
      || Object.keys(part).some((key) => key !== 'insert'))) {
      fail('collaboration_text_state_invalid', 409, '权威协同文本状态损坏或不兼容');
    }
    return {
      text: text.toString(),
      stateVector: Buffer.from(Y.encodeStateVector(document)),
    };
  } catch (error) {
    if (error instanceof CollaborationTextPersistenceError) throw error;
    fail('collaboration_text_state_invalid', 409, '权威协同文本状态损坏或不兼容');
  } finally {
    document.destroy();
  }
}

function publicBinding(record) {
  return {
    contractVersion: COLLABORATION_TEXT_BINDING_CONTRACT,
    projectId: record.projectId,
    canvasId: record.canvasId,
    revision: record.revision,
    targetType: record.targetType,
    targetEntityUid: record.targetEntityUid,
    bindingEpoch: record.bindingEpoch,
    field: record.field,
    state: Buffer.from(record.state).toString('base64'),
    stateVector: Buffer.from(record.stateVector).toString('base64'),
    materializedText: record.materializedText,
  };
}

class CollaborationTextPersistence {
  constructor(database) {
    if (!database
      || typeof database.withProjectDatabaseWrite !== 'function'
      || typeof database.withProjectDatabaseReadSnapshot !== 'function'
      || typeof database.isProjectDatabaseWriteCoordinatorActive !== 'function') {
      throw new Error('CollaborationTextPersistence 需要带统一写事务边界的 ProjectDatabase');
    }
    this.database = database;
  }

  _assertWriteTransaction(operation) {
    if (this.database.isProjectDatabaseWriteCoordinatorActive()) return;
    const error = new Error(`协同文本内部写入 ${operation} 必须位于 ProjectDatabase 写事务中`);
    error.code = 'collaboration_text_write_transaction_required';
    throw error;
  }

  _normalizeIdentity(input = {}) {
    const projectId = boundedIdentity(input.projectId, 'projectId');
    const canvasId = boundedIdentity(input.canvasId, 'canvasId');
    const targetType = String(input.targetType || '');
    const field = String(input.field || '');
    const policy = TEXT_FIELD_POLICIES[targetType]?.[field];
    if (!policy) fail('collaboration_text_field_forbidden', 422, '目标字段不在协同文本白名单中');
    return {
      projectId,
      canvasId,
      targetType,
      targetEntityUid: canonicalUuid(input.targetEntityUid, 'targetEntityUid'),
      field,
      policy,
    };
  }

  _assertPrincipalScope(identity, principal = {}) {
    const projectId = typeof principal.projectId === 'string' ? principal.projectId : '';
    const canvasId = typeof principal.canvasId === 'string' ? principal.canvasId : '';
    if (projectId !== identity.projectId || canvasId !== identity.canvasId) {
      fail(
        'collaboration_text_scope_mismatch',
        403,
        '协同文本作用域与当前会话不一致',
      );
    }
  }

  _reviewTarget(identity) {
    return this.database.listCollaborationTextReviewTargets(identity);
  }

  _resolveTarget(document, identity) {
    let matches = [];
    if (identity.targetType === 'canvas') matches = [document];
    else if (identity.targetType === 'node') matches = Array.isArray(document.nodes) ? document.nodes : [];
    else if (identity.targetType === 'edge') matches = Array.isArray(document.edges) ? document.edges : [];
    else if (identity.targetType === 'review') matches = this._reviewTarget(identity);
    else if (identity.targetType === 'subflow') {
      const instances = Array.isArray(document.subflowInstances) ? document.subflowInstances : [];
      matches = instances.length > 0
        ? instances
        : (Array.isArray(document.nodes) ? document.nodes.filter((node) => node?.type === 'subflow') : []);
    }
    matches = matches.filter((target) => entityUidOf(target) === identity.targetEntityUid);
    if (matches.length > 1) fail('collaboration_text_target_ambiguous', 409, '协同文本目标身份不唯一');
    if (tombstoneContains(document, identity.targetType, identity.targetEntityUid)) {
      fail('collaboration_text_target_deleted', 409, '协同文本目标已删除');
    }
    const target = matches[0];
    if (!target) fail('collaboration_text_target_missing', 404, '协同文本目标不存在');
    if (target.deleted_at != null || target.deletedAt != null
      || ['deleted', 'tombstoned', 'purged'].includes(String(target.lifecycle || target.status || '').toLowerCase())) {
      fail('collaboration_text_target_deleted', 409, '协同文本目标已删除');
    }
    const materialized = readPath(target, identity.policy.path);
    if (materialized !== undefined && typeof materialized !== 'string') {
      fail('collaboration_text_materialization_mismatch', 409, '协同文本物化字段类型无效');
    }
    const materializedText = materialized ?? '';
    if (materializedText.length > identity.policy.maxChars
      || Buffer.byteLength(materializedText, 'utf8') > identity.policy.maxBytes) {
      fail('collaboration_text_materialized_too_large', 413, '协同文本物化正文超过字段上限');
    }
    if (/\u0000|[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(materializedText)) {
      fail('collaboration_text_materialization_mismatch', 409, '协同文本物化正文包含非法控制字符');
    }
    return {
      target,
      legacyId: String(target.id || target.canvasId || identity.canvasId),
      materializedText,
    };
  }

  _bindingRow(identity, legacyId) {
    const { stableRows, priorStableIdentity, legacyRows } = this.database
      .getCollaborationTextBindingRows(identity, legacyId);
    if (stableRows.length > 1) fail('collaboration_text_target_ambiguous', 409, '协同文本绑定身份不唯一');
    if (stableRows[0]) return stableRows[0];
    if (priorStableIdentity) return null;
    if (legacyRows.length > 1) fail('collaboration_text_target_ambiguous', 409, '协同文本绑定身份不唯一');
    return legacyRows[0] || null;
  }

  _archiveReusedDisplayBindingsInTransaction(identity, legacyId) {
    this._assertWriteTransaction('binding.archive-reused-display');
    return this.database.archiveReusedCollaborationTextDisplayBindings(identity, legacyId);
  }

  _latestRestoreRevision(identity, createdRevision, legacyId) {
    if (identity.targetType !== 'node' && identity.targetType !== 'edge') return null;
    const { stableIdentityCount, operations } = this.database
      .getCollaborationTextRestoreEvidence(identity, createdRevision, legacyId);
    for (const row of operations) {
      const payload = parseJson(row.payload_json, {});
      const restored = payload?.[identity.targetType];
      const restoredEntityUid = entityUidOf(restored);
      if (restoredEntityUid === identity.targetEntityUid) return Number(row.revision);
      if (!restoredEntityUid && Number(stableIdentityCount) <= 1
        && String(restored?.id || '') === String(legacyId || '')) return Number(row.revision);
    }
    return null;
  }

  _recordFromRow(row) {
    const state = Buffer.from(row.state_blob || []);
    const decoded = decodePlainTextState(state);
    const stateVector = row.state_vector ? Buffer.from(row.state_vector) : decoded.stateVector;
    const materializedText = row.materialized_text == null ? decoded.text : String(row.materialized_text);
    const stateDigest = sha256(state);
    const textDigest = sha256(Buffer.from(materializedText, 'utf8'));
    const createdRevision = Number(row.created_revision);
    const revision = Number(row.revision);
    if (decoded.text !== materializedText
      || !stateVector.equals(decoded.stateVector)
      || (row.state_digest != null && String(row.state_digest) !== stateDigest)
      || (row.text_digest != null && String(row.text_digest) !== textDigest)
      || !Number.isSafeInteger(createdRevision) || createdRevision < 1
      || !Number.isSafeInteger(revision) || revision < createdRevision) {
      fail('collaboration_text_materialization_mismatch', 409, 'Y.Text 与物化字段不一致');
    }
    return {
      contractVersion: COLLABORATION_TEXT_BINDING_CONTRACT,
      projectId: row.project_id,
      canvasId: row.canvas_id,
      targetType: row.target_type,
      targetEntityUid: canonicalUuid(row.target_entity_uid, 'binding targetEntityUid'),
      bindingEpoch: canonicalUuid(row.binding_epoch, 'bindingEpoch'),
      field: row.field_name,
      lifecycle: String(row.lifecycle || 'active'),
      createdRevision,
      revision,
      state,
      stateVector,
      stateDigest,
      materializedText,
      textDigest,
      updatedBy: row.updated_by,
      updatedAt: Number(row.updated_at),
      legacyId: row.display_target_id || row.target_id,
    };
  }

  _writeBindingInTransaction(record) {
    this._assertWriteTransaction('binding.write');
    return this.database.writeCollaborationTextBinding(record);
  }

  _ensureBindingInTransaction(identity, document, principal = {}) {
    this._assertWriteTransaction('binding.ensure');
    const resolved = this._resolveTarget(document, identity);
    this._archiveReusedDisplayBindingsInTransaction(identity, resolved.legacyId);
    const row = this._bindingRow(identity, resolved.legacyId);
    const legacyRow = row && (!row.target_entity_uid || !row.binding_epoch
      || !Number.isSafeInteger(Number(row.created_revision)) || !Number.isSafeInteger(Number(row.revision))
      || row.materialized_text == null || row.state_vector == null);
    let legacyState = null;
    if (legacyRow) {
      legacyState = Buffer.from(row.state_blob || []);
      const decoded = decodePlainTextState(legacyState);
      if (decoded.text !== resolved.materializedText) {
        fail(
          'collaboration_text_schema_mismatch',
          409,
          '旧协同文本状态与当前画布字段不一致，已保留旧状态并停止自动迁移',
          {
            targetEntityUid: identity.targetEntityUid,
            field: identity.field,
            legacyTextDigest: sha256(Buffer.from(decoded.text, 'utf8')),
            materializedTextDigest: sha256(Buffer.from(resolved.materializedText, 'utf8')),
            recoveryAvailable: true,
            recoveryContractVersion: COLLABORATION_TEXT_RECOVERY_CONTRACT,
          },
        );
      }
    }
    let record = legacyRow ? null : (row ? this._recordFromRow(row) : null);
    const restoredAt = record
      ? this._latestRestoreRevision(identity, record.createdRevision, resolved.legacyId)
      : null;
    if (record && record.lifecycle === 'active' && !restoredAt) {
      if (record.materializedText !== resolved.materializedText) {
        fail('collaboration_text_materialization_mismatch', 409, 'Y.Text 与物化字段不一致');
      }
      return { record, resolved, created: false };
    }
    const encoded = legacyState
      ? {
        state: legacyState,
        stateVector: decodePlainTextState(legacyState).stateVector,
        stateDigest: sha256(legacyState),
        textDigest: sha256(Buffer.from(resolved.materializedText, 'utf8')),
      }
      : encodePlainTextState(resolved.materializedText);
    const now = Date.now();
    record = {
      contractVersion: COLLABORATION_TEXT_BINDING_CONTRACT,
      projectId: identity.projectId,
      canvasId: identity.canvasId,
      targetType: identity.targetType,
      targetEntityUid: identity.targetEntityUid,
      bindingEpoch: crypto.randomUUID(),
      field: identity.field,
      lifecycle: 'active',
      createdRevision: Number(document.revision),
      revision: Number(document.revision),
      state: encoded.state,
      stateVector: encoded.stateVector,
      stateDigest: encoded.stateDigest,
      materializedText: resolved.materializedText,
      textDigest: encoded.textDigest,
      updatedBy: String(principal.memberId || principal.actorId || 'collaboration-reader'),
      updatedAt: now,
      legacyId: resolved.legacyId,
    };
    this._writeBindingInTransaction(record);
    return { record, resolved, created: true };
  }

  _lastClientSeq(identity, principal) {
    return this.database.getCollaborationTextLastClientSequence({
      projectId: identity.projectId,
      canvasId: identity.canvasId,
      actorId: principal.actorId,
      sessionId: principal.sessionId,
    });
  }

  _idempotency(updateId) {
    const row = this.database.getCollaborationTextIdempotencyRecord(updateId);
    if (!row) return null;
    return {
      updateId: row.update_id,
      requestDigest: row.request_digest,
      projectId: row.project_id,
      canvasId: row.canvas_id,
      actorId: row.actor_id,
      sessionId: row.session_id,
      clientSeq: Number(row.client_seq),
      revision: Number(row.revision),
      result: parseJson(row.result_json, {}),
      createdAt: Number(row.created_at),
      noOp: row.noOp === true,
    };
  }

  _isNoOpPlan(plan, binding) {
    return plan.result.text === binding.materializedText
      && Buffer.from(plan.bindingRecord.state, 'base64').equals(Buffer.from(binding.state))
      && Buffer.from(plan.bindingRecord.stateVector, 'base64').equals(Buffer.from(binding.stateVector));
  }

  _recordNoOpInTransaction(plan, identity, binding, document, principal) {
    this._assertWriteTransaction('update.noop');
    const result = {
      ...plan.result,
      revision: Number(document.revision),
      state: Buffer.from(binding.state).toString('base64'),
      stateVector: Buffer.from(binding.stateVector).toString('base64'),
      text: binding.materializedText,
      textDigest: binding.textDigest,
      updatedBy: binding.updatedBy,
    };
    const record = {
      updateId: plan.updateId,
      requestDigest: plan.requestDigest,
      projectId: identity.projectId,
      canvasId: identity.canvasId,
      actorId: principal.actorId,
      sessionId: principal.sessionId,
      clientSeq: plan.idempotencyRecord.clientSeq,
      revision: Number(document.revision),
      result,
      createdAt: plan.idempotencyRecord.createdAt,
      noOp: true,
    };
    this.database.reserveCollaborationOperationIdentity({
      opId: record.updateId,
      projectId: identity.projectId,
      canvasId: identity.canvasId,
      domain: 'text',
      type: 'text.update',
      identityDigest: record.requestDigest,
      createdAt: record.createdAt,
    }, document);
    this.database.insertCollaborationTextIdempotencyRecord({
      ...record,
      targetType: identity.targetType,
      targetEntityUid: identity.targetEntityUid,
      field: identity.field,
      bindingEpoch: binding.bindingEpoch,
      result,
      noOp: true,
    });
    return {
      ...plan,
      duplicate: true,
      noOp: true,
      writes: [],
      operation: null,
      audit: null,
      bindingRecord: binding,
      idempotencyRecord: record,
      result,
      document,
    };
  }

  getLegacyRecoveryModel(input = {}, principal = {}) {
    const identity = this._normalizeIdentity(input);
    this._assertPrincipalScope(identity, principal);
    return this.database.withProjectDatabaseReadSnapshot('collaboration.text.legacy-recovery', () => {
      const document = this.database.getCanvas(identity.canvasId);
      if (!document || document.projectId !== identity.projectId) {
        fail('collaboration_text_target_missing', 404, '画布不存在或无权访问');
      }
      const resolved = this._resolveTarget(document, identity);
      const { priorStableIdentity, legacyRows } = this.database
        .getCollaborationTextBindingRows(identity, resolved.legacyId);
      if (priorStableIdentity) {
        fail(
          'collaboration_text_recovery_unavailable',
          409,
          '显示身份已被新的稳定对象复用，旧正文不能自动归属到当前对象',
        );
      }
      if (legacyRows.length !== 1) {
        fail('collaboration_text_recovery_unavailable', 404, '没有可恢复的旧协同正文');
      }
      const legacyText = decodePlainTextState(Buffer.from(legacyRows[0].state_blob || [])).text;
      if (legacyText === resolved.materializedText) {
        fail('collaboration_text_recovery_unavailable', 409, '旧协同正文与当前物化正文一致，无需恢复');
      }
      return {
        contractVersion: COLLABORATION_TEXT_RECOVERY_CONTRACT,
        projectId: identity.projectId,
        canvasId: identity.canvasId,
        targetType: identity.targetType,
        targetEntityUid: identity.targetEntityUid,
        field: identity.field,
        legacyText,
        currentText: resolved.materializedText,
        legacyTextDigest: sha256(Buffer.from(legacyText, 'utf8')),
        materializedTextDigest: sha256(Buffer.from(resolved.materializedText, 'utf8')),
        preserved: true,
        updatedAt: Math.max(0, Number(legacyRows[0].updated_at) || 0),
      };
    });
  }

  getBindingSnapshot(input = {}, principal = {}) {
    const identity = this._normalizeIdentity(input);
    this._assertPrincipalScope(identity, principal);
    const actorId = String(principal.memberId || principal.actorId || 'collaboration-reader');
    const sessionId = String(principal.sessionId || 'collaboration-read-session');
    return this.database.withProjectDatabaseWrite('collaboration.text.binding.ensure', () => {
      const document = this.database.getCanvas(identity.canvasId);
      if (!document || document.projectId !== identity.projectId) {
        fail('collaboration_text_target_missing', 404, '画布不存在或无权访问');
      }
      const { record } = this._ensureBindingInTransaction(identity, document, { memberId: actorId });
      const nextClientSeq = this._lastClientSeq(identity, { actorId, sessionId }) + 1;
      return { binding: publicBinding(record), nextClientSeq };
    });
  }

  _materializeInTransaction(document, identity, value, timestamp, commitRevision) {
    this._assertWriteTransaction('update.materialize');
    if (identity.targetType === 'review') {
      const changes = this.database.updateCollaborationTextReviewBody({
        value,
        updatedAt: timestamp,
        targetEntityUid: identity.targetEntityUid,
        projectId: identity.projectId,
        canvasId: identity.canvasId,
      });
      if (changes !== 1) fail('collaboration_text_target_missing', 404, '协同文本目标不存在');
      return;
    }
    let target = null;
    if (identity.targetType === 'canvas') target = document;
    else if (identity.targetType === 'node') target = document.nodes.find((item) => entityUidOf(item) === identity.targetEntityUid);
    else if (identity.targetType === 'edge') target = document.edges.find((item) => entityUidOf(item) === identity.targetEntityUid);
    else if (identity.targetType === 'subflow') {
      target = (document.subflowInstances || []).find((item) => entityUidOf(item) === identity.targetEntityUid)
        || document.nodes.find((item) => item?.type === 'subflow' && entityUidOf(item) === identity.targetEntityUid);
    }
    if (!target) fail('collaboration_text_target_missing', 404, '协同文本目标不存在');
    writePath(target, identity.policy.path, value);
    if (identity.targetType === 'node'
      || identity.targetType === 'edge'
      || identity.targetType === 'subflow') {
      target.entityRevision = commitRevision;
    }
  }

  applyUpdate(rawEnvelope, options = {}) {
    const principal = {
      memberId: String(options.principal?.memberId || options.principal?.actorId || ''),
      actorId: String(options.principal?.actorId || options.principal?.memberId || ''),
      sessionId: String(options.principal?.sessionId || ''),
      role: String(options.principal?.role || ''),
      capabilities: Array.isArray(options.principal?.capabilities) ? [...options.principal.capabilities] : [],
      projectId: options.principal?.projectId,
      canvasId: options.principal?.canvasId,
    };
    const translateCapacityAtBoundary = !this.database.isProjectDatabaseWriteCoordinatorActive();
    try {
      return this.database.withProjectDatabaseWrite('collaboration.text.update', () => {
        this._assertWriteTransaction('update.apply');
      const identity = this._normalizeIdentity(rawEnvelope);
      this._assertPrincipalScope(identity, principal);
      const document = this.database.getCanvas(identity.canvasId);
      if (!document || document.projectId !== identity.projectId) {
        fail('collaboration_text_target_missing', 404, '画布不存在或无权访问');
      }
      const idempotencyRecord = this._idempotency(String(rawEnvelope?.updateId || '').toLowerCase());
      if (idempotencyRecord) {
        const replay = authorizeCollaborationTextUpdate(rawEnvelope, {
          document,
          principal,
          transport: { online: true, mode: 'online', queued: false, replayedFromOffline: false },
          binding: {},
          reviewComments: [],
          lastClientSeq: -1,
          idempotencyRecord,
          now: Date.now(),
        });
        return { ...replay, noOp: idempotencyRecord.noOp === true, document };
      }
      const binding = this._ensureBindingInTransaction(identity, document, principal).record;
      const lastClientSeq = this._lastClientSeq(identity, principal);
      const reviewComments = identity.targetType === 'review' ? this._reviewTarget(identity) : [];
      const plan = authorizeCollaborationTextUpdate(rawEnvelope, {
        document,
        principal,
        transport: { online: true, mode: 'online', queued: false, replayedFromOffline: false },
        binding: {
          ...binding,
          state: Buffer.from(binding.state),
        },
        reviewComments,
        lastClientSeq,
        idempotencyRecord,
        now: Date.now(),
      });
      if (plan.duplicate) return { ...plan, document };

      const crossDomainCollision = this.database
        .hasCollaborationTextOperationIdentityCollision(plan.updateId);
      if (crossDomainCollision) {
        fail('collaboration_text_idempotency_collision', 409, '协同文本 updateId 与既有请求碰撞');
      }

      if (this._isNoOpPlan(plan, binding)) {
        return this._recordNoOpInTransaction(plan, identity, binding, document, principal);
      }

      const nextDocument = JSON.parse(JSON.stringify(document));
      this._materializeInTransaction(
        nextDocument,
        identity,
        plan.result.text,
        plan.audit.createdAt,
        plan.result.revision,
      );
      nextDocument.revision = plan.result.revision;
      nextDocument.updatedAt = plan.audit.createdAt;
      const nextBinding = {
        ...plan.bindingRecord,
        state: Buffer.from(plan.bindingRecord.state, 'base64'),
        stateVector: Buffer.from(plan.bindingRecord.stateVector, 'base64'),
        legacyId: binding.legacyId,
      };
      this._writeBindingInTransaction(nextBinding);

      const updated = this.database.commitCollaborationTextCanvasDocument(
        nextDocument,
        document.revision,
        {
        syncResourceGrants: options.syncResourceGrants,
        assertResultingDocument: options.assertResultingDocument,
        },
      );
      if (updated.changes !== 1) {
        fail('collaboration_text_revision_conflict', 409, '协同文本 baseRevision 无效或过期', {
          currentRevision: this.database.getCanvas(identity.canvasId)?.revision,
        });
      }

      this.database.insertCanvasOperationRecord({
        ...plan.operation,
        timestamp: plan.operation.createdAt,
      }, plan.result.revision, true);
      this.database.insertCollaborationTextIdempotencyRecord({
        updateId: plan.updateId,
        requestDigest: plan.requestDigest,
        projectId: identity.projectId,
        canvasId: identity.canvasId,
        targetType: identity.targetType,
        targetEntityUid: identity.targetEntityUid,
        field: identity.field,
        bindingEpoch: plan.result.bindingEpoch,
        actorId: principal.actorId,
        sessionId: principal.sessionId,
        clientSeq: plan.idempotencyRecord.clientSeq,
        revision: plan.result.revision,
        result: plan.result,
        createdAt: plan.idempotencyRecord.createdAt,
        noOp: false,
      });
      const sequence = this.database.advanceCollaborationTextClientSequence({
        projectId: identity.projectId,
        canvasId: identity.canvasId,
        actorId: principal.actorId,
        sessionId: principal.sessionId,
        clientSeq: plan.idempotencyRecord.clientSeq,
        updatedAt: plan.idempotencyRecord.createdAt,
      }, lastClientSeq);
      if (lastClientSeq >= 0 && sequence.changes !== 1) {
        fail('collaboration_text_client_seq_conflict', 409, '协同文本 clientSeq 不连续');
      }
      this.database.appendAuditEvent(plan.audit);
      return { ...plan, document: nextDocument };
      });
    } catch (error) {
      const capacityCode = String(error?.code || '').toUpperCase();
      if (!translateCapacityAtBoundary
        && (/^SQLITE_FULL(?:_|$)/.test(capacityCode)
          || capacityCode === 'ENOSPC'
          || capacityCode === 'EDQUOT')) {
        // The outermost ProjectDatabase boundary must finish rollback before
        // converting physical-capacity failures into the public 507 type.
        throw error;
      }
      if (error instanceof CollaborationTextAuthorityError
        || error instanceof CollaborationTextPersistenceError) throw error;
      if (/^SQLITE_BUSY/.test(String(error?.code || ''))) {
        fail('collaboration_text_revision_conflict', 409, '协同文本并发冲突，请同步后重试');
      }
      throw this.database._translatePermanentLedgerError(error, rawEnvelope?.canvasId);
    }
  }
}

module.exports = {
  COLLABORATION_TEXT_RECOVERY_CONTRACT,
  CollaborationTextPersistence,
  CollaborationTextPersistenceError,
};
