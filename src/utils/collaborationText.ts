import * as Y from 'yjs';

export const COLLABORATION_TEXT_UPDATE_CONTRACT = 't8-collaboration-text-update-v1' as const;
export const COLLABORATION_TEXT_BINDING_CONTRACT = 't8-collaboration-text-binding-v1' as const;
export const COLLABORATION_TEXT_FLUSH_MIN_MS = 100;
export const COLLABORATION_TEXT_FLUSH_MAX_MS = 200;
export const COLLABORATION_TEXT_MAX_UPDATE_BYTES = 256 * 1024;
export const COLLABORATION_TEXT_MAX_MATERIALIZED_BYTES = 1024 * 1024;
export const COLLABORATION_TEXT_CONTENT_NAME = 'content';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const MAX_REMEMBERED_UPDATE_IDS = 4096;
const FORBIDDEN_TEXT_CONTROLS = /\u0000|[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

export type CollaborationTextTargetType = 'canvas' | 'node' | 'edge' | 'review' | 'subflow';
export type CollaborationTextField =
  | 'title'
  | 'description'
  | 'label'
  | 'prompt'
  | 'negativePrompt'
  | 'notes'
  | 'body'
  | 'name';

interface CollaborationTextFieldPolicy {
  maxChars: number;
  maxBytes: number;
}

const TEXT_FIELD_POLICIES: Readonly<Record<
  CollaborationTextTargetType,
  Readonly<Partial<Record<CollaborationTextField, CollaborationTextFieldPolicy>>>
>> = {
  canvas: {
    title: { maxChars: 512, maxBytes: 2 * 1024 },
    description: { maxChars: 50_000, maxBytes: 200 * 1024 },
  },
  node: {
    title: { maxChars: 512, maxBytes: 2 * 1024 },
    label: { maxChars: 512, maxBytes: 2 * 1024 },
    prompt: { maxChars: 200_000, maxBytes: 512 * 1024 },
    negativePrompt: { maxChars: 200_000, maxBytes: 512 * 1024 },
    notes: { maxChars: 50_000, maxBytes: 200 * 1024 },
    description: { maxChars: 50_000, maxBytes: 200 * 1024 },
  },
  edge: {
    label: { maxChars: 512, maxBytes: 2 * 1024 },
    notes: { maxChars: 50_000, maxBytes: 200 * 1024 },
  },
  review: {
    body: { maxChars: 5_000, maxBytes: 20 * 1024 },
  },
  subflow: {
    name: { maxChars: 256, maxBytes: 1024 },
    description: { maxChars: 50_000, maxBytes: 200 * 1024 },
  },
};

export interface CollaborationTextBindingIdentity {
  projectId: string;
  canvasId: string;
  targetType: CollaborationTextTargetType;
  targetEntityUid: string;
  bindingEpoch: string;
  field: CollaborationTextField;
}

export interface CollaborationTextUpdateEnvelope extends CollaborationTextBindingIdentity {
  contractVersion: typeof COLLABORATION_TEXT_UPDATE_CONTRACT;
  updateId: string;
  clientSeq: number;
  baseRevision: number;
  update: string;
}

export interface CollaborationTextBindingSnapshot extends CollaborationTextBindingIdentity {
  contractVersion: typeof COLLABORATION_TEXT_BINDING_CONTRACT;
  revision: number;
  state: string;
  stateVector: string;
  materializedText: string;
}

export type CollaborationTextRecoveryReason =
  | 'target_deleted'
  | 'binding_epoch_mismatch'
  | 'schema_mismatch'
  | 'offline_forbidden'
  | 'revision_conflict';

const RECOVERY_REASONS = new Set<CollaborationTextRecoveryReason>([
  'target_deleted',
  'binding_epoch_mismatch',
  'schema_mismatch',
  'offline_forbidden',
  'revision_conflict',
]);

export interface CollaborationTextRecovery {
  reason: CollaborationTextRecoveryReason;
  projectId: string;
  canvasId: string;
  targetType: CollaborationTextTargetType;
  targetEntityUid: string;
  bindingEpoch: string;
  receivedBindingEpoch: string | null;
  field: CollaborationTextField;
  text: string;
  hadUnflushedChanges: boolean;
  createdAt: number;
}

export interface CollaborationTextApplyResult {
  status: 'applied' | 'duplicate' | 'conflict';
  text: string;
  recovery: CollaborationTextRecovery | null;
}

export interface CollaborationTextClientOptions extends CollaborationTextBindingIdentity {
  baseRevision: number;
  initialClientSeq?: number;
  initialState?: string;
  initialMaterializedText?: string;
  online?: boolean;
  flushDelayMs?: number;
  createUpdateId?: () => string;
  now?: () => number;
  onFlush?: (envelope: CollaborationTextUpdateEnvelope) => void | Promise<void>;
  onDispatchError?: (error: unknown, envelope: CollaborationTextUpdateEnvelope) => void;
}

export class CollaborationTextProtocolError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'CollaborationTextProtocolError';
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new CollaborationTextProtocolError(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string) {
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = typeof key === 'string' ? Object.getOwnPropertyDescriptor(value, key) : null;
    if (typeof key !== 'string'
      || !descriptor?.enumerable
      || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      fail('collaboration_text_envelope_invalid', `${label} 只能包含可枚举数据字段`);
    }
  }
  const keys = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (keys.length !== wanted.length || keys.some((key, index) => key !== wanted[index])) {
    fail('collaboration_text_envelope_invalid', `${label} 字段必须精确匹配协议`);
  }
}

function canonicalUuid(value: unknown, label: string) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    fail('collaboration_text_identity_invalid', `${label} 必须是 RFC 4122 UUID`);
  }
  return value.toLowerCase();
}

function scopeIdentity(value: unknown, label: string) {
  if (typeof value !== 'string'
    || value.length < 1
    || value.length > 240
    || /[\u0000-\u001f\u007f]/.test(value)
    || ['__proto__', 'prototype', 'constructor'].includes(value)) {
    fail('collaboration_text_identity_invalid', `${label} 必须是有界项目/画布标识`);
  }
  return value;
}

function positiveRevision(value: unknown, label: string) {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    fail('collaboration_text_revision_invalid', `${label} 必须是正整数`);
  }
  return Number(value);
}

function clientSequence(value: unknown, label: string) {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    fail('collaboration_text_client_seq_invalid', `${label} 必须是非负安全整数`);
  }
  return Number(value);
}

function normalizeTargetType(value: unknown): CollaborationTextTargetType {
  if (!['canvas', 'node', 'edge', 'review', 'subflow'].includes(String(value))) {
    fail('collaboration_text_target_invalid', 'targetType 不受支持');
  }
  return value as CollaborationTextTargetType;
}

function normalizeField(targetType: CollaborationTextTargetType, value: unknown): CollaborationTextField {
  if (typeof value !== 'string' || !TEXT_FIELD_POLICIES[targetType][value as CollaborationTextField]) {
    fail('collaboration_text_field_forbidden', `${targetType}/${String(value)} 不是允许的协同文本字段`);
  }
  return value as CollaborationTextField;
}

function utf8Bytes(value: string) {
  return new TextEncoder().encode(value).byteLength;
}

function encodeBase64(bytes: Uint8Array) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    const chunk = bytes.subarray(offset, Math.min(bytes.byteLength, offset + chunkSize));
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function decodeCanonicalBase64(value: unknown, label: string, maxBytes: number) {
  if (typeof value !== 'string'
    || value.length === 0
    || value.length > Math.ceil(maxBytes * 4 / 3) + 4
    || !BASE64_PATTERN.test(value)) {
    fail('collaboration_text_update_invalid', `${label} 必须是 canonical base64`);
  }
  let binary = '';
  try {
    binary = atob(value);
  } catch {
    fail('collaboration_text_update_invalid', `${label} 必须是 canonical base64`);
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  if (!bytes.byteLength || bytes.byteLength > maxBytes || encodeBase64(bytes) !== value) {
    fail(
      bytes.byteLength > maxBytes ? 'collaboration_text_update_too_large' : 'collaboration_text_update_invalid',
      `${label} 为空、过大或不是 canonical base64`,
    );
  }
  return bytes;
}

function normalizeBindingIdentity(value: CollaborationTextBindingIdentity): CollaborationTextBindingIdentity {
  if (!isRecord(value)) fail('collaboration_text_binding_invalid', '协同文本绑定无效');
  const targetType = normalizeTargetType(value.targetType);
  return {
    projectId: scopeIdentity(value.projectId, 'projectId'),
    canvasId: scopeIdentity(value.canvasId, 'canvasId'),
    targetType,
    targetEntityUid: canonicalUuid(value.targetEntityUid, 'targetEntityUid'),
    bindingEpoch: canonicalUuid(value.bindingEpoch, 'bindingEpoch'),
    field: normalizeField(targetType, value.field),
  };
}

export function normalizeCollaborationTextUpdateEnvelope(raw: unknown): CollaborationTextUpdateEnvelope {
  if (!isRecord(raw)) fail('collaboration_text_envelope_invalid', '协同文本更新信封必须是普通对象');
  exactKeys(raw, [
    'contractVersion',
    'updateId',
    'clientSeq',
    'projectId',
    'canvasId',
    'baseRevision',
    'targetType',
    'targetEntityUid',
    'bindingEpoch',
    'field',
    'update',
  ], '协同文本更新信封');
  if (raw.contractVersion !== COLLABORATION_TEXT_UPDATE_CONTRACT) {
    fail('collaboration_text_contract_invalid', `contractVersion 必须是 ${COLLABORATION_TEXT_UPDATE_CONTRACT}`);
  }
  const targetType = normalizeTargetType(raw.targetType);
  const update = decodeCanonicalBase64(raw.update, 'update', COLLABORATION_TEXT_MAX_UPDATE_BYTES);
  return {
    contractVersion: COLLABORATION_TEXT_UPDATE_CONTRACT,
    updateId: canonicalUuid(raw.updateId, 'updateId'),
    clientSeq: clientSequence(raw.clientSeq, 'clientSeq'),
    projectId: scopeIdentity(raw.projectId, 'projectId'),
    canvasId: scopeIdentity(raw.canvasId, 'canvasId'),
    baseRevision: positiveRevision(raw.baseRevision, 'baseRevision'),
    targetType,
    targetEntityUid: canonicalUuid(raw.targetEntityUid, 'targetEntityUid'),
    bindingEpoch: canonicalUuid(raw.bindingEpoch, 'bindingEpoch'),
    field: normalizeField(targetType, raw.field),
    update: encodeBase64(update),
  };
}

function normalizeBindingSnapshot(raw: unknown): CollaborationTextBindingSnapshot {
  if (!isRecord(raw)) fail('collaboration_text_binding_invalid', '协同文本绑定快照必须是普通对象');
  exactKeys(raw, [
    'contractVersion',
    'projectId',
    'canvasId',
    'revision',
    'targetType',
    'targetEntityUid',
    'bindingEpoch',
    'field',
    'state',
    'stateVector',
    'materializedText',
  ], '协同文本绑定快照');
  if (raw.contractVersion !== COLLABORATION_TEXT_BINDING_CONTRACT) {
    fail('collaboration_text_contract_invalid', `contractVersion 必须是 ${COLLABORATION_TEXT_BINDING_CONTRACT}`);
  }
  const targetType = normalizeTargetType(raw.targetType);
  if (typeof raw.materializedText !== 'string'
    || utf8Bytes(raw.materializedText) > COLLABORATION_TEXT_MAX_MATERIALIZED_BYTES) {
    fail('collaboration_text_materialization_mismatch', 'materializedText 无效或过大');
  }
  const state = decodeCanonicalBase64(raw.state, 'state', COLLABORATION_TEXT_MAX_UPDATE_BYTES * 4);
  const stateVector = decodeCanonicalBase64(raw.stateVector, 'stateVector', COLLABORATION_TEXT_MAX_UPDATE_BYTES);
  return {
    contractVersion: COLLABORATION_TEXT_BINDING_CONTRACT,
    projectId: scopeIdentity(raw.projectId, 'projectId'),
    canvasId: scopeIdentity(raw.canvasId, 'canvasId'),
    revision: positiveRevision(raw.revision, 'revision'),
    targetType,
    targetEntityUid: canonicalUuid(raw.targetEntityUid, 'targetEntityUid'),
    bindingEpoch: canonicalUuid(raw.bindingEpoch, 'bindingEpoch'),
    field: normalizeField(targetType, raw.field),
    state: encodeBase64(state),
    stateVector: encodeBase64(stateVector),
    materializedText: raw.materializedText,
  };
}

function sameBinding(left: CollaborationTextBindingIdentity, right: CollaborationTextBindingIdentity) {
  return left.projectId === right.projectId
    && left.canvasId === right.canvasId
    && left.targetType === right.targetType
    && left.targetEntityUid === right.targetEntityUid
    && left.bindingEpoch === right.bindingEpoch
    && left.field === right.field;
}

function assertPlainTextDocument(document: Y.Doc) {
  const text = document.getText(COLLABORATION_TEXT_CONTENT_NAME);
  const roots = [...document.share.entries()];
  if (roots.length !== 1
    || roots[0][0] !== COLLABORATION_TEXT_CONTENT_NAME
    || !(roots[0][1] instanceof Y.Text)) {
    fail('collaboration_text_update_invalid', '协同文本状态只能包含 content Y.Text');
  }
  if (text.toDelta().some((part: { insert?: unknown; attributes?: unknown }) => (
    typeof part.insert !== 'string'
    || Object.prototype.hasOwnProperty.call(part, 'attributes')
    || Object.keys(part).some((key) => key !== 'insert')
  ))) fail('collaboration_text_update_invalid', '协同文本禁止富文本或嵌入对象');
}

function assertMaterializedLimit(text: string, identity: CollaborationTextBindingIdentity) {
  const policy = TEXT_FIELD_POLICIES[identity.targetType][identity.field];
  if (!policy
    || text.length > policy.maxChars
    || utf8Bytes(text) > policy.maxBytes
    || utf8Bytes(text) > COLLABORATION_TEXT_MAX_MATERIALIZED_BYTES) {
    fail('collaboration_text_materialized_too_large', '协同文本物化正文超过字段上限');
  }
  if (FORBIDDEN_TEXT_CONTROLS.test(text)) {
    fail('collaboration_text_value_invalid', '协同文本正文包含禁止的控制字符');
  }
}

function defaultUpdateId() {
  const value = globalThis.crypto?.randomUUID?.();
  if (!value) fail('collaboration_text_identity_unavailable', '当前环境无法生成安全 updateId');
  return value;
}

/**
 * A single in-memory Y.Text binding. It deliberately has no storage adapter and
 * never replays text while offline; callers must create a fresh binding from the
 * authoritative snapshot after a scope/lifecycle conflict.
 */
export class CollaborationTextClient {
  readonly identity: Readonly<CollaborationTextBindingIdentity>;

  private readonly document: Y.Doc;
  private readonly text: Y.Text;
  private readonly localOrigin = Object.freeze({ kind: 't8-collaboration-text-local' });
  private readonly remoteOrigin = Object.freeze({ kind: 't8-collaboration-text-remote' });
  private readonly undoManager: Y.UndoManager;
  private readonly flushDelayMs: number;
  private readonly createUpdateId: () => string;
  private readonly now: () => number;
  private readonly onFlush?: CollaborationTextClientOptions['onFlush'];
  private readonly onDispatchError?: CollaborationTextClientOptions['onDispatchError'];
  private readonly rememberedUpdateIds = new Set<string>();
  private readonly rememberedUpdateOrder: string[] = [];
  private pendingUpdates: Uint8Array[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private nextClientSeq: number;
  private baseRevision: number;
  private recovery: CollaborationTextRecovery | null = null;
  private online: boolean;
  private disposed = false;

  constructor(options: CollaborationTextClientOptions) {
    this.identity = Object.freeze(normalizeBindingIdentity(options));
    this.baseRevision = positiveRevision(options.baseRevision, 'baseRevision');
    this.nextClientSeq = clientSequence(options.initialClientSeq ?? 0, 'initialClientSeq');
    this.online = options.online === true;
    this.flushDelayMs = Number(options.flushDelayMs ?? 150);
    if (!Number.isInteger(this.flushDelayMs)
      || this.flushDelayMs < COLLABORATION_TEXT_FLUSH_MIN_MS
      || this.flushDelayMs > COLLABORATION_TEXT_FLUSH_MAX_MS) {
      fail(
        'collaboration_text_flush_delay_invalid',
        `flushDelayMs 必须是 ${COLLABORATION_TEXT_FLUSH_MIN_MS}-${COLLABORATION_TEXT_FLUSH_MAX_MS} 的整数`,
      );
    }
    this.createUpdateId = options.createUpdateId || defaultUpdateId;
    this.now = options.now || Date.now;
    this.onFlush = options.onFlush;
    this.onDispatchError = options.onDispatchError;
    this.document = new Y.Doc();
    this.text = this.document.getText(COLLABORATION_TEXT_CONTENT_NAME);

    if (options.initialState != null) {
      const initialState = decodeCanonicalBase64(
        options.initialState,
        'initialState',
        COLLABORATION_TEXT_MAX_UPDATE_BYTES * 4,
      );
      try {
        Y.applyUpdate(this.document, initialState, this.remoteOrigin);
      } catch {
        this.document.destroy();
        fail('collaboration_text_update_invalid', 'initialState 不是有效的 Yjs v1 update');
      }
    }
    assertPlainTextDocument(this.document);
    assertMaterializedLimit(this.text.toString(), this.identity);
    if (options.initialMaterializedText != null
      && options.initialMaterializedText !== this.text.toString()) {
      this.document.destroy();
      fail('collaboration_text_materialization_mismatch', '初始 Y.Text 与权威物化正文不一致');
    }

    this.undoManager = new Y.UndoManager(this.text, {
      trackedOrigins: new Set([this.localOrigin]),
      captureTimeout: this.flushDelayMs,
    });
    this.document.on('update', this.handleDocumentUpdate);
  }

  static fromBindingSnapshot(
    raw: unknown,
    options: Omit<CollaborationTextClientOptions, keyof CollaborationTextBindingIdentity | 'baseRevision' | 'initialState' | 'initialMaterializedText'> = {},
  ) {
    const snapshot = normalizeBindingSnapshot(raw);
    return new CollaborationTextClient({
      ...options,
      projectId: snapshot.projectId,
      canvasId: snapshot.canvasId,
      baseRevision: snapshot.revision,
      targetType: snapshot.targetType,
      targetEntityUid: snapshot.targetEntityUid,
      bindingEpoch: snapshot.bindingEpoch,
      field: snapshot.field,
      initialState: snapshot.state,
      initialMaterializedText: snapshot.materializedText,
    });
  }

  private readonly handleDocumentUpdate = (update: Uint8Array, origin: unknown) => {
    if (this.disposed || this.recovery) return;
    if (origin !== this.localOrigin && origin !== this.undoManager) return;
    this.pendingUpdates.push(new Uint8Array(update));
    if (this.onFlush && !this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        let envelope: CollaborationTextUpdateEnvelope | null = null;
        try {
          envelope = this.flushInternal();
          if (!envelope) return;
          Promise.resolve(this.onFlush?.(envelope)).catch((error) => {
            this.onDispatchError?.(error, envelope!);
          });
        } catch (error) {
          if (envelope) this.onDispatchError?.(error, envelope);
          else if (this.onDispatchError) {
            const unavailable = this.peekEnvelopeForError();
            if (unavailable) this.onDispatchError(error, unavailable);
          }
        }
      }, this.flushDelayMs);
    }
  };

  private peekEnvelopeForError(): CollaborationTextUpdateEnvelope | null {
    if (!this.pendingUpdates.length) return null;
    try {
      const update = Y.mergeUpdates(this.pendingUpdates);
      return {
        contractVersion: COLLABORATION_TEXT_UPDATE_CONTRACT,
        updateId: '00000000-0000-4000-8000-000000000000',
        clientSeq: this.nextClientSeq,
        projectId: this.identity.projectId,
        canvasId: this.identity.canvasId,
        baseRevision: this.baseRevision,
        targetType: this.identity.targetType,
        targetEntityUid: this.identity.targetEntityUid,
        bindingEpoch: this.identity.bindingEpoch,
        field: this.identity.field,
        update: encodeBase64(update),
      };
    } catch {
      return null;
    }
  }

  private assertEditable() {
    if (this.disposed) fail('collaboration_text_disposed', '协同文本绑定已释放');
    if (this.recovery) fail('collaboration_text_conflicted', '协同文本绑定已进入冲突恢复，不能继续编辑');
    if (!this.online) fail('collaboration_text_offline_forbidden', '协同文本只允许在线编辑，不能进入离线队列');
  }

  private rememberUpdateId(updateId: string) {
    if (this.rememberedUpdateIds.has(updateId)) return;
    this.rememberedUpdateIds.add(updateId);
    this.rememberedUpdateOrder.push(updateId);
    while (this.rememberedUpdateOrder.length > MAX_REMEMBERED_UPDATE_IDS) {
      const removed = this.rememberedUpdateOrder.shift();
      if (removed) this.rememberedUpdateIds.delete(removed);
    }
  }

  private enterRecovery(
    reason: CollaborationTextRecoveryReason,
    receivedBindingEpoch: string | null = null,
  ) {
    if (this.recovery) return this.getRecovery();
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    const recovery: CollaborationTextRecovery = {
      reason,
      ...this.identity,
      receivedBindingEpoch,
      text: this.text.toString(),
      hadUnflushedChanges: this.pendingUpdates.length > 0,
      createdAt: this.now(),
    };
    this.pendingUpdates = [];
    this.undoManager.clear();
    this.recovery = recovery;
    return this.getRecovery();
  }

  private flushInternal(): CollaborationTextUpdateEnvelope | null {
    this.assertEditable();
    if (!this.pendingUpdates.length) return null;
    const merged = Y.mergeUpdates(this.pendingUpdates);
    if (!merged.byteLength || merged.byteLength > COLLABORATION_TEXT_MAX_UPDATE_BYTES) {
      fail('collaboration_text_update_too_large', '本次协同文本增量超过 256 KiB，未发送');
    }
    const updateId = canonicalUuid(this.createUpdateId(), 'updateId');
    const envelope: CollaborationTextUpdateEnvelope = {
      contractVersion: COLLABORATION_TEXT_UPDATE_CONTRACT,
      updateId,
      clientSeq: this.nextClientSeq,
      projectId: this.identity.projectId,
      canvasId: this.identity.canvasId,
      baseRevision: this.baseRevision,
      targetType: this.identity.targetType,
      targetEntityUid: this.identity.targetEntityUid,
      bindingEpoch: this.identity.bindingEpoch,
      field: this.identity.field,
      update: encodeBase64(merged),
    };
    normalizeCollaborationTextUpdateEnvelope(envelope);
    this.pendingUpdates = [];
    this.nextClientSeq += 1;
    this.rememberUpdateId(updateId);
    return envelope;
  }

  get materializedText() {
    return this.text.toString();
  }

  get encodedState() {
    return encodeBase64(Y.encodeStateAsUpdate(this.document));
  }

  get encodedStateVector() {
    return encodeBase64(Y.encodeStateVector(this.document));
  }

  get pendingUpdateCount() {
    return this.pendingUpdates.length;
  }

  get currentBaseRevision() {
    return this.baseRevision;
  }

  get nextSequence() {
    return this.nextClientSeq;
  }

  get hasConflict() {
    return this.recovery != null;
  }

  get isOnline() {
    return this.online;
  }

  get canUndo() {
    return this.online && !this.recovery && !this.disposed && this.undoManager.undoStack.length > 0;
  }

  get canRedo() {
    return this.online && !this.recovery && !this.disposed && this.undoManager.redoStack.length > 0;
  }

  replaceText(next: string) {
    this.assertEditable();
    if (typeof next !== 'string') fail('collaboration_text_value_invalid', '协同文本正文必须是字符串');
    assertMaterializedLimit(next, this.identity);
    const current = this.text.toString();
    if (current === next) return false;
    let prefix = 0;
    while (prefix < current.length && prefix < next.length && current[prefix] === next[prefix]) prefix += 1;
    let suffix = 0;
    while (
      suffix < current.length - prefix
      && suffix < next.length - prefix
      && current[current.length - 1 - suffix] === next[next.length - 1 - suffix]
    ) suffix += 1;
    const deleteCount = current.length - prefix - suffix;
    const insertion = next.slice(prefix, next.length - suffix);
    this.document.transact(() => {
      if (deleteCount > 0) this.text.delete(prefix, deleteCount);
      if (insertion) this.text.insert(prefix, insertion);
    }, this.localOrigin);
    return true;
  }

  insertText(index: number, value: string) {
    this.assertEditable();
    if (!Number.isSafeInteger(index) || index < 0 || index > this.text.length || typeof value !== 'string') {
      fail('collaboration_text_edit_invalid', '插入位置或正文无效');
    }
    if (!value) return false;
    const candidate = `${this.text.toString().slice(0, index)}${value}${this.text.toString().slice(index)}`;
    assertMaterializedLimit(candidate, this.identity);
    this.document.transact(() => this.text.insert(index, value), this.localOrigin);
    return true;
  }

  deleteText(index: number, length: number) {
    this.assertEditable();
    if (!Number.isSafeInteger(index)
      || !Number.isSafeInteger(length)
      || index < 0
      || length < 0
      || index + length > this.text.length) {
      fail('collaboration_text_edit_invalid', '删除范围无效');
    }
    if (length === 0) return false;
    this.document.transact(() => this.text.delete(index, length), this.localOrigin);
    return true;
  }

  undo() {
    this.assertEditable();
    const before = this.text.toString();
    this.undoManager.undo();
    return before !== this.text.toString();
  }

  redo() {
    this.assertEditable();
    const before = this.text.toString();
    this.undoManager.redo();
    return before !== this.text.toString();
  }

  stopUndoCapture() {
    this.assertEditable();
    this.undoManager.stopCapturing();
  }

  setOnline(online: boolean) {
    if (this.disposed) fail('collaboration_text_disposed', '协同文本绑定已释放');
    if (typeof online !== 'boolean') fail('collaboration_text_connection_invalid', 'online 必须是布尔值');
    if (!online && this.online && this.pendingUpdates.length > 0) {
      this.online = false;
      return this.enterRecovery('offline_forbidden');
    }
    this.online = online;
    return this.getRecovery();
  }

  flush() {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    return this.flushInternal();
  }

  advanceBaseRevision(revision: number) {
    this.assertEditable();
    const normalized = positiveRevision(revision, 'revision');
    if (normalized < this.baseRevision) {
      fail('collaboration_text_revision_invalid', '协同文本 baseRevision 不得回退');
    }
    this.baseRevision = normalized;
  }

  applyAuthoritativeSnapshot(
    raw: unknown,
    options: { allowLocalSuperset?: boolean } = {},
  ): CollaborationTextApplyResult {
    if (this.disposed) fail('collaboration_text_disposed', '协同文本绑定已释放');
    if (this.recovery) {
      return { status: 'conflict', text: this.text.toString(), recovery: this.getRecovery() };
    }
    const snapshot = normalizeBindingSnapshot(raw);
    const sameScopeAndTarget = snapshot.projectId === this.identity.projectId
      && snapshot.canvasId === this.identity.canvasId
      && snapshot.targetType === this.identity.targetType
      && snapshot.targetEntityUid === this.identity.targetEntityUid
      && snapshot.field === this.identity.field;
    if (!sameScopeAndTarget) {
      fail('collaboration_text_scope_mismatch', '权威协同文本快照不属于当前绑定');
    }
    if (snapshot.bindingEpoch !== this.identity.bindingEpoch) {
      return {
        status: 'conflict',
        text: this.text.toString(),
        recovery: this.enterRecovery('binding_epoch_mismatch', snapshot.bindingEpoch),
      };
    }
    if (snapshot.revision < this.baseRevision) {
      fail('collaboration_text_revision_invalid', '权威协同文本快照 revision 不得回退');
    }

    const state = decodeCanonicalBase64(
      snapshot.state,
      'authoritativeState',
      COLLABORATION_TEXT_MAX_UPDATE_BYTES * 4,
    );
    const authoritative = new Y.Doc();
    const candidate = new Y.Doc();
    try {
      Y.applyUpdate(authoritative, state);
      assertPlainTextDocument(authoritative);
      const authoritativeText = authoritative.getText(COLLABORATION_TEXT_CONTENT_NAME).toString();
      assertMaterializedLimit(authoritativeText, this.identity);
      if (authoritativeText !== snapshot.materializedText
        || encodeBase64(Y.encodeStateVector(authoritative)) !== snapshot.stateVector) {
        fail('collaboration_text_materialization_mismatch', '权威协同文本快照状态与物化正文不一致');
      }

      Y.applyUpdate(candidate, Y.encodeStateAsUpdate(this.document));
      Y.applyUpdate(candidate, state);
      assertPlainTextDocument(candidate);
      const candidateText = candidate.getText(COLLABORATION_TEXT_CONTENT_NAME).toString();
      assertMaterializedLimit(candidateText, this.identity);
      if (options.allowLocalSuperset !== true
        && (candidateText !== snapshot.materializedText
          || encodeBase64(Y.encodeStateVector(candidate)) !== snapshot.stateVector)) {
        fail('collaboration_text_materialization_mismatch', '当前权威影子状态与主机快照不一致');
      }
    } catch (error) {
      if (error instanceof CollaborationTextProtocolError) throw error;
      fail('collaboration_text_update_invalid', '权威协同文本快照不是有效的 Yjs v1 状态');
    } finally {
      authoritative.destroy();
      candidate.destroy();
    }

    try {
      Y.applyUpdate(this.document, state, this.remoteOrigin);
    } catch {
      fail('collaboration_text_update_invalid', '权威协同文本快照不是有效的 Yjs v1 状态');
    }
    this.baseRevision = snapshot.revision;
    return { status: 'applied', text: this.text.toString(), recovery: null };
  }

  applyRemoteEnvelope(raw: unknown): CollaborationTextApplyResult {
    if (this.disposed) fail('collaboration_text_disposed', '协同文本绑定已释放');
    if (this.recovery) {
      return { status: 'conflict', text: this.text.toString(), recovery: this.getRecovery() };
    }
    if (isRecord(raw)
      && typeof raw.contractVersion === 'string'
      && raw.contractVersion !== COLLABORATION_TEXT_UPDATE_CONTRACT) {
      return {
        status: 'conflict',
        text: this.text.toString(),
        recovery: this.enterRecovery('schema_mismatch'),
      };
    }
    const envelope = normalizeCollaborationTextUpdateEnvelope(raw);
    const envelopeIdentity: CollaborationTextBindingIdentity = envelope;
    const sameScopeAndTarget = envelope.projectId === this.identity.projectId
      && envelope.canvasId === this.identity.canvasId
      && envelope.targetType === this.identity.targetType
      && envelope.targetEntityUid === this.identity.targetEntityUid
      && envelope.field === this.identity.field;
    if (!sameScopeAndTarget) {
      fail('collaboration_text_scope_mismatch', '远端协同文本更新不属于当前绑定');
    }
    if (envelope.bindingEpoch !== this.identity.bindingEpoch) {
      return {
        status: 'conflict',
        text: this.text.toString(),
        recovery: this.enterRecovery('binding_epoch_mismatch', envelope.bindingEpoch),
      };
    }
    if (!sameBinding(this.identity, envelopeIdentity)) {
      fail('collaboration_text_scope_mismatch', '远端协同文本绑定身份不一致');
    }
    if (this.rememberedUpdateIds.has(envelope.updateId)) {
      return { status: 'duplicate', text: this.text.toString(), recovery: null };
    }

    const update = decodeCanonicalBase64(envelope.update, 'update', COLLABORATION_TEXT_MAX_UPDATE_BYTES);
    const candidate = new Y.Doc();
    try {
      Y.applyUpdate(candidate, Y.encodeStateAsUpdate(this.document));
      Y.applyUpdate(candidate, update);
      assertPlainTextDocument(candidate);
      assertMaterializedLimit(candidate.getText(COLLABORATION_TEXT_CONTENT_NAME).toString(), this.identity);
    } catch (error) {
      if (error instanceof CollaborationTextProtocolError) throw error;
      fail('collaboration_text_update_invalid', '远端 update 不是有效的 Yjs v1 update');
    } finally {
      candidate.destroy();
    }
    try {
      Y.applyUpdate(this.document, update, this.remoteOrigin);
    } catch {
      fail('collaboration_text_update_invalid', '远端 update 不是有效的 Yjs v1 update');
    }
    this.rememberUpdateId(envelope.updateId);
    return { status: 'applied', text: this.text.toString(), recovery: null };
  }

  registerConflict(
    reason: CollaborationTextRecoveryReason,
    receivedBindingEpoch: string | null = null,
  ) {
    if (!RECOVERY_REASONS.has(reason)) {
      fail('collaboration_text_conflict_invalid', '协同文本冲突原因无效');
    }
    if (receivedBindingEpoch != null) receivedBindingEpoch = canonicalUuid(receivedBindingEpoch, 'receivedBindingEpoch');
    return this.enterRecovery(reason, receivedBindingEpoch);
  }

  registerAuthorityError(error: unknown) {
    const code = isRecord(error) ? String(error.code || '') : String(error || '');
    if (code === 'collaboration_text_target_deleted') return this.enterRecovery('target_deleted');
    if (code === 'collaboration_text_offline_forbidden') return this.enterRecovery('offline_forbidden');
    if ([
      'collaboration_text_revision_conflict',
      'collaboration_text_client_seq_conflict',
      'collaboration_text_idempotency_collision',
    ].includes(code)) return this.enterRecovery('revision_conflict');
    if (code === 'collaboration_text_binding_epoch_mismatch') {
      const details = isRecord(error) && isRecord(error.details) ? error.details : null;
      const rawEpoch = details?.currentBindingEpoch ?? (isRecord(error) ? error.bindingEpoch : null);
      const received = typeof rawEpoch === 'string'
        ? canonicalUuid(rawEpoch, 'bindingEpoch')
        : null;
      return this.enterRecovery('binding_epoch_mismatch', received);
    }
    if ([
      'collaboration_text_schema_mismatch',
      'collaboration_text_binding_invalid',
      'collaboration_text_field_forbidden',
      'collaboration_text_materialization_mismatch',
    ].includes(code)) {
      return this.enterRecovery('schema_mismatch');
    }
    return null;
  }

  getRecovery(): CollaborationTextRecovery | null {
    return this.recovery ? Object.freeze({ ...this.recovery }) : null;
  }

  copyRecoveryText() {
    return this.recovery?.text ?? null;
  }

  discardRecovery() {
    if (!this.recovery) return false;
    this.recovery = null;
    this.dispose();
    return true;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    this.pendingUpdates = [];
    this.rememberedUpdateIds.clear();
    this.rememberedUpdateOrder.length = 0;
    this.undoManager.destroy();
    this.document.off('update', this.handleDocumentUpdate);
    this.document.destroy();
  }
}
