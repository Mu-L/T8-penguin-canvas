const Y = require('yjs');

const MAX_TEXT_UPDATE_BYTES = 256 * 1024;
const ALLOWED_TARGET_TYPES = new Set(['canvas', 'node', 'edge', 'review', 'subflow']);

function normalizeTextKey(input = {}) {
  const projectId = String(input.projectId || 'project-local');
  const canvasId = String(input.canvasId || '');
  const targetType = String(input.targetType || 'node');
  const targetId = String(input.targetId || '');
  const field = String(input.field || 'text');
  if (!canvasId) throw new Error('协同文本缺少 canvasId');
  if (!ALLOWED_TARGET_TYPES.has(targetType)) throw new Error('协同文本 targetType 无效');
  if (!targetId || targetId.length > 200) throw new Error('协同文本 targetId 无效');
  if (!/^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/.test(field)) throw new Error('协同文本 field 无效');
  return { projectId, canvasId, targetType, targetId, field };
}

function decodeUpdate(value) {
  const encoded = String(value || '');
  if (!encoded || encoded.length > Math.ceil(MAX_TEXT_UPDATE_BYTES * 4 / 3) + 16) throw new Error('协同文本更新为空或过大');
  const update = Buffer.from(encoded, 'base64');
  if (!update.length || update.length > MAX_TEXT_UPDATE_BYTES) throw new Error('协同文本更新为空或过大');
  return update;
}

class CollaborativeTextStore {
  constructor(database) {
    this.database = database;
  }

  load(input) {
    const key = normalizeTextKey(input);
    const record = this.database.getCollaborativeTextDocument(key);
    const document = new Y.Doc();
    if (record?.state?.length) Y.applyUpdate(document, record.state);
    return { key, record, document };
  }

  read(input) {
    const { key, record, document } = this.load(input);
    const state = Buffer.from(Y.encodeStateAsUpdate(document));
    return {
      ...key,
      state: state.toString('base64'),
      stateVector: Buffer.from(Y.encodeStateVector(document)).toString('base64'),
      text: document.getText('content').toString(),
      updatedBy: record?.updatedBy || null,
      updatedAt: record?.updatedAt || null,
    };
  }

  apply(input, encodedUpdate, context = {}) {
    const update = decodeUpdate(encodedUpdate);
    const { key, document } = this.load(input);
    try {
      Y.applyUpdate(document, update);
    } catch (_) {
      throw new Error('协同文本更新格式无效');
    }
    const state = Buffer.from(Y.encodeStateAsUpdate(document));
    if (state.length > MAX_TEXT_UPDATE_BYTES * 4) throw new Error('协同文本正文超过持久化上限');
    const record = this.database.saveCollaborativeTextDocument({
      ...key,
      state,
      updatedBy: context.actorId,
    });
    this.database.appendAuditEvent({
      projectId: key.projectId,
      canvasId: key.canvasId,
      actorId: context.actorId,
      sessionId: context.sessionId,
      action: 'collaboration.text.update',
      targetType: key.targetType,
      targetId: key.targetId,
      metadata: { field: key.field, updateBytes: update.length, stateBytes: state.length },
    });
    return {
      ...key,
      state: state.toString('base64'),
      stateVector: Buffer.from(Y.encodeStateVector(document)).toString('base64'),
      text: document.getText('content').toString(),
      updatedBy: record.updatedBy,
      updatedAt: record.updatedAt,
    };
  }
}

module.exports = {
  ALLOWED_TARGET_TYPES,
  MAX_TEXT_UPDATE_BYTES,
  CollaborativeTextStore,
  normalizeTextKey,
};
