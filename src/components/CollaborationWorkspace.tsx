import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type NodeMouseHandler,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { CircleUserRound, GitFork, Loader2, LogOut, Plus, Play, RefreshCw, RotateCcw, Shield, Trash2, Upload, Users, X } from 'lucide-react';
import type {
  CollaborationRun,
  CollaborationRunAsset,
  CollaborationRunAttempt,
  CollaborationRunError,
  CollaborationRunEvent,
  CollaborationRunIntentView,
  CollaborationRunNode,
  CollaborationRunSyncMeta,
  CollaborationRunUsage,
  CollaborationReviewComment,
  CollaborationReviewThread,
  RunIntent,
  VersionedCanvasData,
  WorkspaceCapability,
  WorkspaceRole,
} from '../types/project';
import {
  logoutCurrentCollaborationSession,
  rotateCurrentCollaborationSession,
} from '../services/api';
import {
  PORT_COLOR,
  isConnectionValid,
  resolveNodeConnectionPorts,
  type ResolvedNodeConnectionPorts,
} from '../config/portTypes';
import {
  classifyCollaborationClose,
  classifyCollaborationSessionHeartbeatFailure,
  collaborationHeartbeatExpired,
  collaborationReconnectDelay,
  collaborationSessionHeartbeatIdentity,
  COLLABORATION_HANDSHAKE_TIMEOUT_MS,
  COLLABORATION_PROTOCOL_VERSION,
  COLLABORATION_REQUEST_TIMEOUT_MS,
  COLLABORATION_SESSION_HEARTBEAT_INTERVAL_MS,
  CollaborationSessionHeartbeatSingleFlight,
  normalizeCollaborationProtocol,
  sameCollaborationSessionHeartbeatIdentity,
  type CollaborationConnectionPhase,
  type CollaborationGatewayNotice,
} from '../utils/collaborationConnection';
import {
  collaborationQueueStats,
  collaborationQueueStorageKey,
  enqueueCollaborationOperation,
  firstCollaborationQueueItemForReplay,
  freezeCollaborationQueue,
  loadCollaborationQueue,
  pendingNodeMoveOverrides,
  removeCollaborationQueueItem,
  sameCollaborationQueueScope,
  saveCollaborationQueue,
  updateCollaborationQueueItem,
  validCollaborationQueue,
  type CollaborationQueueItem,
  type CollaborationQueueScope,
} from '../utils/collaborationOfflineQueue';
import {
  acceptCommonCollaborationMutationResult,
  acceptCollaborationMoveMutationResult,
  applyCollaborationSync,
  collaborationDeltaAcknowledgesQueuedMove,
  CollaborationSyncFallbackError,
  COLLABORATION_SYNC_MAX_OPERATIONS,
  type CollaborationSyncEnvelope,
  type CollaborationSyncEnvelopeOperations,
} from '../utils/collaborationSync';
import { createCanvasEntityUid } from '../utils/canvasEntityIdentity';
import { buildCommonGraphBatch } from '../utils/commonGraphOperations';
import {
  COLLABORATION_TEXT_MAX_MATERIALIZED_BYTES,
  CollaborationTextClient,
  CollaborationTextProtocolError,
  normalizeCollaborationTextUpdateEnvelope,
  type CollaborationTextBindingSnapshot,
  type CollaborationTextField,
  type CollaborationTextRecoveryReason,
  type CollaborationTextTargetType,
  type CollaborationTextUpdateEnvelope,
} from '../utils/collaborationText';
import type { SubflowDefinition } from '../utils/subflows';
import {
  collaborationDeleteDrafts,
  collaborationEdgeAddDraft,
  collaborationPresenceWithDrag,
  collaborationRemoteDragPositions,
  collaborationRestoreEdgeDraft,
  collaborationRestoreNodeDraft,
  collaborationTextNodeAddDraft,
  shouldSendCollaborationDragPreview,
  type CollaborationDragPreview,
  type CollaborationOperationDraft,
  type CollaborationPresenceValue,
} from '../utils/collaborationStructure';
import {
  beginCollaborationRunOperation,
  completeCollaborationRunOperation,
  readCollaborationRunOperation,
  type CollaborationRunOperation,
} from '../utils/collaborationRunOperation';
import CollaborationAssetUpload from './CollaborationAssetUpload';
import CollaborationReviewPanel, {
  type CollaborationReviewApiEnvelope,
} from './CollaborationReviewPanel';
import CollaborationConflictPanel, {
  type CollaborationConflictReason,
  type CollaborationStructureConflictItem,
  type CollaborationTextConflictItem,
} from './CollaborationConflictPanel';

const COLLABORATION_TEXT_RESULT_KEYS = Object.freeze([
  'contractVersion',
  'updateId',
  'projectId',
  'canvasId',
  'baseRevision',
  'revision',
  'targetType',
  'targetEntityUid',
  'bindingEpoch',
  'field',
  'state',
  'stateVector',
  'text',
  'textDigest',
  'updatedBy',
]);

const COLLABORATION_TEXT_RECOVERY_KEYS = Object.freeze([
  'contractVersion',
  'projectId',
  'canvasId',
  'targetType',
  'targetEntityUid',
  'field',
  'legacyText',
  'currentText',
  'legacyTextDigest',
  'materializedTextDigest',
  'preserved',
  'updatedAt',
]);

interface CollaborationTextMutationResult {
  contractVersion: 't8-collaboration-text-update-v1';
  updateId: string;
  projectId: string;
  canvasId: string;
  baseRevision: number;
  revision: number;
  targetType: CollaborationTextTargetType;
  targetEntityUid: string;
  bindingEpoch: string;
  field: CollaborationTextField;
  state: string;
  stateVector: string;
  text: string;
  textDigest: string;
  updatedBy: string;
}

export interface CollaborationTextLegacyRecoveryModel {
  contractVersion: 't8-collaboration-text-recovery-v1';
  projectId: string;
  canvasId: string;
  targetType: CollaborationTextTargetType;
  targetEntityUid: string;
  field: CollaborationTextField;
  legacyText: string;
  currentText: string;
  legacyTextDigest: string;
  materializedTextDigest: string;
  preserved: true;
  updatedAt: number;
}

export interface CollaborationWorkspaceTextDescriptor {
  targetType: CollaborationTextTargetType;
  targetEntityUid: string;
  field: CollaborationTextField;
  displayId?: string;
  label?: string;
  authoritativeText?: string;
}

export interface CollaborationWorkspaceTextView extends CollaborationWorkspaceTextDescriptor {
  key: string;
  text: string;
  canUndo: boolean;
  canRedo: boolean;
  baseRevision: number;
}

export interface CollaborationTextRecoveryScopeIdentity {
  id?: string;
  projectId: string;
  canvasId: string;
  memberId: string;
}

/**
 * Recovery plaintext is scoped to the authenticated subject, but deliberately
 * excludes authorizationEpoch/capabilities so a role refresh for that exact
 * subject cannot erase a copy-only recovery item.
 */
export function collaborationTextRecoveryScopeKey(
  identity: CollaborationTextRecoveryScopeIdentity | null | undefined,
) {
  const parts = identity
    ? [identity.id, identity.projectId, identity.canvasId, identity.memberId]
      .map((value) => String(value || ''))
    : [];
  if (parts.length !== 4
    || parts.some((value) => !value || value.length > 240 || /[\u0000-\u001f\u007f]/.test(value))) return '';
  return JSON.stringify(parts);
}

function collaborationTextBindingScopeKey(session: Session | null | undefined) {
  const recoveryScope = collaborationTextRecoveryScopeKey(session);
  if (!recoveryScope || !session) return '';
  return JSON.stringify([
    recoveryScope,
    String(session.authorizationEpoch),
    [...session.capabilities].sort(),
  ]);
}

/**
 * Memory-only, subject-scoped recovery storage. Activating another subject
 * never returns the previous subject's plaintext; returning to the exact old
 * scope restores it until the user explicitly discards it.
 */
export class CollaborationTextConflictScopeVault {
  private readonly itemsByScope = new Map<string, CollaborationTextConflictItem[]>();
  private readonly quarantinedItems: CollaborationTextConflictItem[] = [];
  private activeScope = '';

  activate(scope: string) {
    this.activeScope = String(scope || '');
    return this.items(this.activeScope);
  }

  isActive(scope: string) {
    return Boolean(scope) && this.activeScope === scope;
  }

  items(scope: string) {
    if (!scope) return [];
    return [...(this.itemsByScope.get(scope) || [])];
  }

  add(scope: string, item: CollaborationTextConflictItem) {
    if (!scope) {
      if (!this.quarantinedItems.some((candidate) => candidate.id === item.id)) {
        this.quarantinedItems.push(item);
      }
      return [];
    }
    const current = this.itemsByScope.get(scope) || [];
    if (current.some((candidate) => candidate.id === item.id)) return [...current];
    const next = [...current, item];
    this.itemsByScope.set(scope, next);
    return [...next];
  }

  discard(scope: string, item: CollaborationTextConflictItem) {
    if (!scope) return [];
    const next = (this.itemsByScope.get(scope) || [])
      .filter((candidate) => candidate.id !== item.id);
    if (next.length) this.itemsByScope.set(scope, next);
    else this.itemsByScope.delete(scope);
    return [...next];
  }
}

interface CollaborationWorkspaceTextEntry {
  descriptor: CollaborationWorkspaceTextDescriptor;
  client: CollaborationTextClient;
  authorityClient: CollaborationTextClient;
}

interface CollaborationWorkspaceTextRegistryOptions {
  submit: (envelope: CollaborationTextUpdateEnvelope) => Promise<CollaborationTextSubmissionResult>;
  onView: (key: string, view: CollaborationWorkspaceTextView | null) => void;
  onConflict: (item: CollaborationTextConflictItem) => void;
  onAccepted?: (
    result: CollaborationTextMutationResult,
    envelope: CollaborationTextUpdateEnvelope,
  ) => void;
  flushDelayMs?: number;
  createUpdateId?: () => string;
  now?: () => number;
}

export interface CollaborationTextSubmissionResult {
  data: unknown;
  noOp: boolean;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactDataKeys(value: Record<string, unknown>, expected: readonly string[]) {
  const keys = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return keys.length === wanted.length && keys.every((key, index) => key === wanted[index]);
}

function textProtocolError(code: string, message: string) {
  return new CollaborationTextProtocolError(code, message);
}

async function normalizeCollaborationTextMutationResult(
  raw: unknown,
  envelope: CollaborationTextUpdateEnvelope,
  noOp: boolean,
): Promise<CollaborationTextMutationResult> {
  if (!isPlainRecord(raw) || !exactDataKeys(raw, COLLABORATION_TEXT_RESULT_KEYS)) {
    throw textProtocolError('collaboration_text_result_invalid', '协同文本确认结果字段不完整');
  }
  if (raw.contractVersion !== envelope.contractVersion
    || raw.updateId !== envelope.updateId
    || raw.projectId !== envelope.projectId
    || raw.canvasId !== envelope.canvasId
    || raw.baseRevision !== envelope.baseRevision
    || raw.targetType !== envelope.targetType
    || raw.targetEntityUid !== envelope.targetEntityUid
    || raw.bindingEpoch !== envelope.bindingEpoch
    || raw.field !== envelope.field
    || typeof raw.revision !== 'number'
    || !Number.isSafeInteger(raw.revision)
    || (noOp
      ? raw.revision < envelope.baseRevision
      : raw.revision <= envelope.baseRevision)
    || typeof raw.text !== 'string'
    || typeof raw.textDigest !== 'string'
    || !/^[0-9a-f]{64}$/.test(raw.textDigest)
    || typeof raw.updatedBy !== 'string'
    || !raw.updatedBy) {
    throw textProtocolError('collaboration_text_result_invalid', '协同文本确认结果身份或 revision 无效');
  }
  const verifier = CollaborationTextClient.fromBindingSnapshot({
    contractVersion: 't8-collaboration-text-binding-v1',
    projectId: raw.projectId,
    canvasId: raw.canvasId,
    revision: raw.revision,
    targetType: raw.targetType,
    targetEntityUid: raw.targetEntityUid,
    bindingEpoch: raw.bindingEpoch,
    field: raw.field,
    state: raw.state,
    stateVector: raw.stateVector,
    materializedText: raw.text,
  }, { online: false });
  try {
    if (verifier.encodedStateVector !== raw.stateVector) {
      throw textProtocolError(
        'collaboration_text_result_invalid',
        '协同文本确认结果 stateVector 与 state 不一致',
      );
    }
  } finally {
    verifier.dispose();
  }
  if (!globalThis.crypto?.subtle) {
    throw textProtocolError('collaboration_text_result_invalid', '当前环境无法校验协同文本摘要');
  }
  const digest = [...new Uint8Array(await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(raw.text),
  ))].map((value) => value.toString(16).padStart(2, '0')).join('');
  if (digest !== raw.textDigest) {
    throw textProtocolError('collaboration_text_result_invalid', '协同文本确认结果 textDigest 不匹配');
  }
  return raw as unknown as CollaborationTextMutationResult;
}

function collaborationTextMutationSnapshot(
  result: CollaborationTextMutationResult,
): CollaborationTextBindingSnapshot {
  return {
    contractVersion: 't8-collaboration-text-binding-v1',
    projectId: result.projectId,
    canvasId: result.canvasId,
    revision: result.revision,
    targetType: result.targetType,
    targetEntityUid: result.targetEntityUid,
    bindingEpoch: result.bindingEpoch,
    field: result.field,
    state: result.state,
    stateVector: result.stateVector,
    materializedText: result.text,
  };
}

function normalizeCollaborationTextSubmission(
  raw: unknown,
): CollaborationTextSubmissionResult {
  if (!isPlainRecord(raw)
    || !exactDataKeys(raw, ['data', 'noOp'])
    || typeof raw.noOp !== 'boolean') {
    throw textProtocolError(
      'collaboration_text_transport_invalid',
      '协同文本响应缺少严格的 no-op 传输标记',
    );
  }
  return { data: raw.data, noOp: raw.noOp };
}

function collaborationTextEnvelopeLeavesAuthorityUnchanged(
  envelope: CollaborationTextUpdateEnvelope,
  authority: CollaborationTextClient,
) {
  const state = authority.encodedState;
  const stateVector = authority.encodedStateVector;
  const text = authority.materializedText;
  const verifier = CollaborationTextClient.fromBindingSnapshot({
    contractVersion: 't8-collaboration-text-binding-v1',
    projectId: envelope.projectId,
    canvasId: envelope.canvasId,
    revision: authority.currentBaseRevision,
    targetType: envelope.targetType,
    targetEntityUid: envelope.targetEntityUid,
    bindingEpoch: envelope.bindingEpoch,
    field: envelope.field,
    state,
    stateVector,
    materializedText: text,
  }, { online: true });
  try {
    const applied = verifier.applyRemoteEnvelope(envelope);
    return applied.status !== 'conflict'
      && verifier.encodedState === state
      && verifier.encodedStateVector === stateVector
      && verifier.materializedText === text;
  } finally {
    verifier.dispose();
  }
}

export function collaborationWorkspaceTextKey(
  descriptor: Pick<CollaborationWorkspaceTextDescriptor, 'targetType' | 'targetEntityUid' | 'field'>,
) {
  return `${descriptor.targetType}\u0001${descriptor.targetEntityUid}\u0001${descriptor.field}`;
}

export function normalizeCollaborationTextGatewayEvent(raw: unknown) {
  if (!isPlainRecord(raw) || raw.type !== 'collaboration.text-update') {
    throw textProtocolError('collaboration_text_event_invalid', '协同文本 WebSocket 事件无效');
  }
  const source = isPlainRecord(raw.envelope) ? raw.envelope : raw;
  const envelope = normalizeCollaborationTextUpdateEnvelope({
    contractVersion: source.contractVersion,
    updateId: source.updateId,
    clientSeq: source.clientSeq,
    projectId: source.projectId,
    canvasId: source.canvasId,
    baseRevision: source.baseRevision,
    targetType: source.targetType,
    targetEntityUid: source.targetEntityUid,
    bindingEpoch: source.bindingEpoch,
    field: source.field,
    update: source.update,
  });
  if (typeof raw.revision !== 'number'
    || !Number.isSafeInteger(raw.revision)
    || raw.revision <= envelope.baseRevision) {
    throw textProtocolError('collaboration_text_event_invalid', '协同文本 WebSocket revision 无效');
  }
  return { envelope, revision: Number(raw.revision) };
}

export type CollaborationTextGatewayRevisionAction = 'apply' | 'recover' | 'ignore';

export function collaborationTextGatewayRevisionAction(
  event: ReturnType<typeof normalizeCollaborationTextGatewayEvent>,
  context: {
    projectId: string;
    canvasId: string;
    currentRevision: number;
    recoveryInFlight: boolean;
    authorityBaselineMatches: boolean;
  },
): CollaborationTextGatewayRevisionAction {
  if (event.envelope.projectId !== context.projectId
    || event.envelope.canvasId !== context.canvasId) {
    throw textProtocolError(
      'collaboration_text_scope_mismatch',
      '协同文本 WebSocket 更新超出当前授权作用域',
    );
  }
  if (!Number.isSafeInteger(context.currentRevision) || context.currentRevision < 0) {
    throw textProtocolError(
      'collaboration_text_revision_invalid',
      '当前权威画布 revision 无效',
    );
  }
  if (event.revision <= context.currentRevision) return 'ignore';
  if (context.recoveryInFlight
    || event.envelope.baseRevision !== context.currentRevision
    || event.revision !== context.currentRevision + 1
    || !context.authorityBaselineMatches) return 'recover';
  return 'apply';
}

function collaborationTextRecoveryError(message: string) {
  return textProtocolError('collaboration_text_recovery_invalid', message);
}

async function collaborationTextDigest(value: string) {
  if (!globalThis.crypto?.subtle) {
    throw collaborationTextRecoveryError('当前环境无法校验旧协同文本摘要');
  }
  return [...new Uint8Array(await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value),
  ))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function normalizeCollaborationTextLegacyRecovery(
  raw: unknown,
  expected: {
    projectId: string;
    canvasId: string;
    targetType: CollaborationTextTargetType;
    targetEntityUid: string;
    field: CollaborationTextField;
    authoritativeText?: string;
  },
): Promise<CollaborationTextLegacyRecoveryModel> {
  if (!isPlainRecord(raw) || !exactDataKeys(raw, COLLABORATION_TEXT_RECOVERY_KEYS)) {
    throw collaborationTextRecoveryError('旧协同文本恢复响应字段不完整');
  }
  if (raw.contractVersion !== 't8-collaboration-text-recovery-v1'
    || raw.projectId !== expected.projectId
    || raw.canvasId !== expected.canvasId
    || raw.targetType !== expected.targetType
    || raw.targetEntityUid !== expected.targetEntityUid
    || raw.field !== expected.field) {
    throw collaborationTextRecoveryError('旧协同文本恢复响应作用域或目标不匹配');
  }
  if (typeof raw.legacyText !== 'string'
    || typeof raw.currentText !== 'string'
    || new TextEncoder().encode(raw.legacyText).byteLength > COLLABORATION_TEXT_MAX_MATERIALIZED_BYTES
    || new TextEncoder().encode(raw.currentText).byteLength > COLLABORATION_TEXT_MAX_MATERIALIZED_BYTES
    || (expected.authoritativeText != null && raw.currentText !== expected.authoritativeText)
    || raw.legacyText === raw.currentText
    || typeof raw.legacyTextDigest !== 'string'
    || !/^[0-9a-f]{64}$/.test(raw.legacyTextDigest)
    || typeof raw.materializedTextDigest !== 'string'
    || !/^[0-9a-f]{64}$/.test(raw.materializedTextDigest)
    || raw.preserved !== true
    || !Number.isSafeInteger(raw.updatedAt)
    || Number(raw.updatedAt) < 0) {
    throw collaborationTextRecoveryError('旧协同文本恢复响应正文、摘要或保留状态无效');
  }
  const [legacyTextDigest, materializedTextDigest] = await Promise.all([
    collaborationTextDigest(raw.legacyText),
    collaborationTextDigest(raw.currentText),
  ]);
  if (legacyTextDigest !== raw.legacyTextDigest
    || materializedTextDigest !== raw.materializedTextDigest) {
    throw collaborationTextRecoveryError('旧协同文本恢复响应摘要不匹配');
  }
  return raw as unknown as CollaborationTextLegacyRecoveryModel;
}

export function collaborationTextLegacyRecoveryConflict(
  recovery: CollaborationTextLegacyRecoveryModel,
  descriptor: Pick<CollaborationWorkspaceTextDescriptor, 'displayId' | 'label'> = {},
): CollaborationTextConflictItem {
  return {
    id: `legacy:${recovery.targetType}:${recovery.targetEntityUid}:${recovery.field}:${recovery.legacyTextDigest}`,
    kind: 'text',
    reason: 'schema',
    target: {
      entityType: recovery.targetType,
      entityUid: recovery.targetEntityUid,
      ...(descriptor.displayId ? { displayId: descriptor.displayId } : {}),
      ...(descriptor.label ? { label: descriptor.label } : {}),
    },
    field: recovery.field,
    localText: recovery.legacyText,
    createdAt: recovery.updatedAt,
  };
}

export async function copyCollaborationTextConflictExact(
  item: CollaborationTextConflictItem,
  writeText: (text: string) => void | Promise<void>,
) {
  await writeText(item.localText);
}

export type CollaborationTextConflictCopyMethod = 'clipboard-api' | 'exec-command';

export interface CollaborationTextConflictCopyEnvironment {
  clipboard?: Pick<Clipboard, 'writeText'> | null;
  document?: Document | null;
}

function legacyCopyCollaborationTextExact(
  exactText: string,
  copyDocument: Document | null,
): CollaborationTextConflictCopyMethod {
  if (!copyDocument?.body
    || typeof copyDocument.createElement !== 'function'
    || typeof copyDocument.execCommand !== 'function') {
    throw new Error('无法自动复制完整恢复文本；请展开完整正文并手工选择复制。');
  }
  const previousFocus = copyDocument.activeElement as HTMLElement | null;
  const textarea = copyDocument.createElement('textarea');
  textarea.value = exactText;
  textarea.readOnly = true;
  textarea.tabIndex = -1;
  textarea.setAttribute('aria-hidden', 'true');
  textarea.style.position = 'fixed';
  textarea.style.left = '-10000px';
  textarea.style.top = '0';
  textarea.style.width = '1px';
  textarea.style.height = '1px';
  textarea.style.opacity = '0';
  textarea.style.pointerEvents = 'none';
  copyDocument.body.appendChild(textarea);
  try {
    textarea.focus({ preventScroll: true });
    textarea.select();
    textarea.setSelectionRange(0, exactText.length);
    if (copyDocument.execCommand('copy') !== true) {
      throw new Error('无法自动复制完整恢复文本；请展开完整正文并手工选择复制。');
    }
    return 'exec-command';
  } finally {
    textarea.remove();
    try { previousFocus?.focus({ preventScroll: true }); } catch { /* focus restoration is best effort */ }
  }
}

/**
 * Copies only the exact conflict text. Missing/synchronously rejected Clipboard
 * API access falls back before the originating click handler yields, which keeps
 * LAN HTTP recovery usable without persisting the memory-only conflict.
 */
export function copyCollaborationTextConflictToClipboardExact(
  item: CollaborationTextConflictItem,
  exactText: string,
  environment: CollaborationTextConflictCopyEnvironment = {},
): Promise<CollaborationTextConflictCopyMethod> {
  if (exactText !== item.localText) {
    throw new Error('恢复文本复制身份不一致。');
  }
  const clipboard = environment.clipboard === undefined
    ? (typeof navigator === 'undefined' ? null : navigator.clipboard)
    : environment.clipboard;
  const copyDocument = environment.document === undefined
    ? (typeof document === 'undefined' ? null : document)
    : environment.document;
  const fallback = () => legacyCopyCollaborationTextExact(exactText, copyDocument);
  const fallbackPromise = () => {
    try {
      return Promise.resolve(fallback());
    } catch (error) {
      return Promise.reject(error);
    }
  };
  if (!clipboard || typeof clipboard.writeText !== 'function') return fallbackPromise();
  let writeResult: void | Promise<void>;
  try {
    writeResult = clipboard.writeText(exactText);
  } catch {
    return fallbackPromise();
  }
  return Promise.resolve(writeResult).then(
    () => 'clipboard-api',
    () => fallbackPromise(),
  );
}

export function discardCollaborationTextConflict(
  current: readonly CollaborationTextConflictItem[],
  item: CollaborationTextConflictItem,
) {
  return current.filter((candidate) => candidate.id !== item.id);
}

export function collaborationTextConflictsForConnection(
  current: readonly CollaborationTextConflictItem[],
  _online: boolean,
): CollaborationTextConflictItem[] {
  return [...current];
}

function conflictReasonFromRecovery(reason: CollaborationTextRecoveryReason): CollaborationConflictReason {
  if (reason === 'target_deleted') return 'deleted';
  if (reason === 'binding_epoch_mismatch') return 'binding_epoch';
  if (reason === 'schema_mismatch') return 'schema';
  if (reason === 'offline_forbidden') return 'offline';
  return 'revision';
}

function collaborationTextAuthorityErrorRecord(error: unknown) {
  if (isPlainRecord(error)) return error;
  if (!error || typeof error !== 'object') return { code: String(error || '') };
  const value = error as {
    code?: unknown;
    status?: unknown;
    details?: unknown;
    bindingEpoch?: unknown;
  };
  return {
    code: typeof value.code === 'string' ? value.code : '',
    status: value.status,
    details: isPlainRecord(value.details) ? value.details : undefined,
    bindingEpoch: typeof value.bindingEpoch === 'string' ? value.bindingEpoch : undefined,
  };
}

function conflictReasonFromError(error: unknown): CollaborationConflictReason {
  const record = collaborationTextAuthorityErrorRecord(error);
  const code = String(record.code || '');
  if (code === 'collaboration_text_target_deleted') return 'deleted';
  if (code === 'collaboration_text_binding_epoch_mismatch') return 'binding_epoch';
  if (code === 'collaboration_text_permission_denied') return 'permission';
  if (code === 'collaboration_text_offline_forbidden'
    || code === 'collaboration_request_timeout'
    || !Number.isInteger(Number(record.status))) return 'offline';
  if (code.includes('schema')
    || code.includes('binding_invalid')
    || code.includes('contract')
    || code.includes('result_invalid')
    || code.includes('event_invalid')) return 'schema';
  return 'revision';
}

/**
 * Memory-only coordinator for active collaborative text fields. It deliberately
 * has no queue or persistence adapter; going offline closes every Y.Doc after
 * surfacing unaccepted plaintext through the in-memory conflict callback.
 */
export class CollaborationWorkspaceTextRegistry {
  private readonly entries = new Map<string, CollaborationWorkspaceTextEntry>();
  private readonly confirmedUpdates = new Map<string, ReturnType<typeof normalizeCollaborationTextGatewayEvent>>();
  private readonly confirmedUpdateOrder: string[] = [];
  private readonly options: CollaborationWorkspaceTextRegistryOptions;
  private dispatchTail: Promise<void> = Promise.resolve();
  private nextClientSeq: number | null = null;
  private generation = 0;
  private online = false;
  private disposed = false;

  constructor(options: CollaborationWorkspaceTextRegistryOptions) {
    this.options = options;
  }

  private assertOnline() {
    if (this.disposed) throw textProtocolError('collaboration_text_disposed', '协同文本注册表已销毁');
    if (!this.online) throw textProtocolError('collaboration_text_offline_forbidden', '协同文本只允许在线编辑');
  }

  private view(key: string, entry: CollaborationWorkspaceTextEntry): CollaborationWorkspaceTextView {
    return {
      key,
      ...entry.descriptor,
      text: entry.client.materializedText,
      canUndo: entry.client.canUndo,
      canRedo: entry.client.canRedo,
      baseRevision: entry.client.currentBaseRevision,
    };
  }

  private emit(key: string, entry: CollaborationWorkspaceTextEntry) {
    this.options.onView(key, this.view(key, entry));
  }

  private removeEntry(key: string, entry: CollaborationWorkspaceTextEntry) {
    if (this.entries.get(key) !== entry) return;
    entry.client.dispose();
    entry.authorityClient.dispose();
    this.entries.delete(key);
    this.options.onView(key, null);
  }

  private failEntry(key: string, entry: CollaborationWorkspaceTextEntry, error: unknown) {
    if (this.entries.get(key) !== entry) return;
    const hasUnacceptedText = entry.client.pendingUpdateCount > 0
      || entry.client.materializedText !== entry.authorityClient.materializedText;
    if (!hasUnacceptedText) {
      this.removeEntry(key, entry);
      return;
    }
    let recovery = entry.client.getRecovery();
    if (!recovery) {
      try {
        recovery = entry.client.registerAuthorityError(
          collaborationTextAuthorityErrorRecord(error),
        );
      } catch { /* use safe fallback below */ }
    }
    const localText = recovery?.text ?? entry.client.materializedText;
    const reason = recovery
      ? conflictReasonFromRecovery(recovery.reason)
      : conflictReasonFromError(error);
    const conflict: CollaborationTextConflictItem = {
      id: `text:${createCanvasEntityUid()}`,
      kind: 'text',
      reason,
      target: {
        entityType: entry.descriptor.targetType,
        entityUid: entry.descriptor.targetEntityUid,
        ...(entry.descriptor.displayId ? { displayId: entry.descriptor.displayId } : {}),
        ...(entry.descriptor.label ? { label: entry.descriptor.label } : {}),
      },
      field: entry.descriptor.field,
      localText,
      createdAt: Math.max(0, Math.trunc(this.options.now?.() ?? Date.now())),
    };
    this.removeEntry(key, entry);
    this.options.onConflict(conflict);
  }

  private async dispatch(key: string, envelope: CollaborationTextUpdateEnvelope) {
    const entry = this.entries.get(key);
    if (!entry) return;
    const dispatchGeneration = this.generation;
    let dispatchedEnvelope: CollaborationTextUpdateEnvelope | null = null;
    try {
      this.assertOnline();
      if (this.nextClientSeq == null) {
        throw textProtocolError('collaboration_text_client_seq_invalid', '协同文本客户端序号尚未载入');
      }
      const currentEnvelope = normalizeCollaborationTextUpdateEnvelope({
        ...envelope,
        clientSeq: this.nextClientSeq,
        baseRevision: entry.client.currentBaseRevision,
      });
      dispatchedEnvelope = currentEnvelope;
      const submission = normalizeCollaborationTextSubmission(
        await this.options.submit(currentEnvelope),
      );
      const result = await normalizeCollaborationTextMutationResult(
        submission.data,
        currentEnvelope,
        submission.noOp,
      );
      if (dispatchGeneration !== this.generation) return;
      const resultSnapshot = collaborationTextMutationSnapshot(result);
      const resultVerifier = CollaborationTextClient.fromBindingSnapshot(
        resultSnapshot,
        { online: true },
      );
      try {
        if (!collaborationTextEnvelopeLeavesAuthorityUnchanged(
          currentEnvelope,
          resultVerifier,
        )) {
          throw textProtocolError(
            'collaboration_text_result_invalid',
            '协同文本确认结果未包含已提交的 Yjs 更新',
          );
        }
      } finally {
        resultVerifier.dispose();
      }
      if (submission.noOp) {
        if (this.entries.get(key) === entry) {
          const authorityApplied = entry.authorityClient.applyAuthoritativeSnapshot(resultSnapshot);
          const localApplied = entry.client.applyAuthoritativeSnapshot(
            resultSnapshot,
            { allowLocalSuperset: true },
          );
          if (authorityApplied.status === 'conflict' || localApplied.status === 'conflict') {
            throw textProtocolError(
              'collaboration_text_materialization_mismatch',
              '协同文本 no-op 权威快照无法安全合并',
            );
          }
          this.advanceRevision(result.revision);
        }
        return;
      }
      if (this.entries.get(key) === entry) {
        const authorityApplied = entry.authorityClient.applyAuthoritativeSnapshot(resultSnapshot);
        const localApplied = entry.client.applyAuthoritativeSnapshot(
          resultSnapshot,
          { allowLocalSuperset: true },
        );
        if (authorityApplied.status === 'conflict' || localApplied.status === 'conflict') {
          throw textProtocolError(
            'collaboration_text_materialization_mismatch',
            '协同文本权威确认快照无法安全合并',
          );
        }
      }
      this.nextClientSeq = currentEnvelope.clientSeq + 1;
      this.advanceRevision(result.revision);
      this.options.onAccepted?.(result, currentEnvelope);
    } catch (error) {
      if (dispatchGeneration !== this.generation) return;
      const confirmation = this.confirmedUpdates.get(envelope.updateId);
      if (confirmation
        && dispatchedEnvelope
        && confirmation.envelope.clientSeq === dispatchedEnvelope.clientSeq
        && confirmation.envelope.projectId === dispatchedEnvelope.projectId
        && confirmation.envelope.canvasId === dispatchedEnvelope.canvasId
        && confirmation.envelope.baseRevision === dispatchedEnvelope.baseRevision
        && confirmation.envelope.targetType === dispatchedEnvelope.targetType
        && confirmation.envelope.targetEntityUid === dispatchedEnvelope.targetEntityUid
        && confirmation.envelope.bindingEpoch === dispatchedEnvelope.bindingEpoch
        && confirmation.envelope.field === dispatchedEnvelope.field
        && confirmation.envelope.update === dispatchedEnvelope.update) {
        this.nextClientSeq = dispatchedEnvelope.clientSeq + 1;
        if (this.entries.get(key) === entry) {
          this.advanceRevision(confirmation.revision);
        }
        return;
      }
      if (!isDefinitiveCollaborationOperationRejection(error)) {
        this.online = false;
        for (const [activeKey, activeEntry] of [...this.entries]) {
          this.failEntry(activeKey, activeEntry, error);
        }
      } else {
        this.failEntry(key, entry, error);
      }
    }
  }

  setOnline(online: boolean) {
    if (this.disposed) return;
    const nextOnline = online === true;
    if (this.online && !nextOnline) {
      this.generation += 1;
      this.online = false;
      for (const [key, entry] of [...this.entries]) {
        const hasUnacceptedText = entry.client.pendingUpdateCount > 0
          || entry.client.materializedText !== entry.authorityClient.materializedText;
        if (hasUnacceptedText) {
          this.failEntry(key, entry, { code: 'collaboration_text_offline_forbidden' });
        } else {
          this.removeEntry(key, entry);
        }
      }
      this.nextClientSeq = null;
      this.confirmedUpdates.clear();
      this.confirmedUpdateOrder.length = 0;
      return;
    }
    this.online = nextOnline;
  }

  open(
    snapshot: CollaborationTextBindingSnapshot,
    nextClientSeq: number,
    descriptor: Pick<CollaborationWorkspaceTextDescriptor, 'displayId' | 'label'> = {},
  ) {
    this.assertOnline();
    if (!Number.isSafeInteger(nextClientSeq) || nextClientSeq < 0) {
      throw textProtocolError('collaboration_text_client_seq_invalid', '协同文本下一序号无效');
    }
    const key = collaborationWorkspaceTextKey(snapshot);
    this.close(key, {
      code: 'collaboration_text_binding_reloaded',
      status: 409,
    });
    const client = CollaborationTextClient.fromBindingSnapshot(snapshot, {
      online: true,
      initialClientSeq: nextClientSeq,
      flushDelayMs: this.options.flushDelayMs ?? 150,
      ...(this.options.createUpdateId ? { createUpdateId: this.options.createUpdateId } : {}),
      onFlush: (envelope) => {
        this.dispatchTail = this.dispatchTail.then(() => this.dispatch(key, envelope));
        return this.dispatchTail;
      },
    });
    const authorityClient = CollaborationTextClient.fromBindingSnapshot(snapshot, { online: true });
    if (client.encodedStateVector !== snapshot.stateVector
      || authorityClient.encodedStateVector !== snapshot.stateVector) {
      client.dispose();
      authorityClient.dispose();
      throw textProtocolError(
        'collaboration_text_binding_invalid',
        '协同文本绑定 stateVector 与 state 不一致',
      );
    }
    this.nextClientSeq = Math.max(this.nextClientSeq ?? 0, nextClientSeq);
    const entry: CollaborationWorkspaceTextEntry = {
      descriptor: {
        targetType: snapshot.targetType,
        targetEntityUid: snapshot.targetEntityUid,
        field: snapshot.field,
        ...descriptor,
      },
      client,
      authorityClient,
    };
    this.entries.set(key, entry);
    this.emit(key, entry);
    return this.view(key, entry);
  }

  replaceText(key: string, text: string) {
    this.assertOnline();
    const entry = this.entries.get(key);
    if (!entry) throw textProtocolError('collaboration_text_binding_invalid', '协同文本绑定尚未载入');
    const changed = entry.client.replaceText(text);
    if (changed) this.emit(key, entry);
    return changed;
  }

  undo(key: string) {
    this.assertOnline();
    const entry = this.entries.get(key);
    if (!entry) return false;
    const changed = entry.client.undo();
    if (changed) this.emit(key, entry);
    return changed;
  }

  redo(key: string) {
    this.assertOnline();
    const entry = this.entries.get(key);
    if (!entry) return false;
    const changed = entry.client.redo();
    if (changed) this.emit(key, entry);
    return changed;
  }

  authorityBaselineMatches(
    envelope: CollaborationTextUpdateEnvelope,
    revision: number,
  ) {
    if (this.disposed || !this.online
      || !Number.isSafeInteger(revision)
      || revision < 1
      || envelope.baseRevision !== revision) return false;
    const entry = this.entries.get(collaborationWorkspaceTextKey(envelope));
    return Boolean(entry
      && entry.client.currentBaseRevision === revision
      && entry.authorityClient.currentBaseRevision === revision);
  }

  applyGatewayEvent(raw: unknown) {
    this.assertOnline();
    const event = normalizeCollaborationTextGatewayEvent(raw);
    if (!this.confirmedUpdates.has(event.envelope.updateId)) {
      this.confirmedUpdates.set(event.envelope.updateId, event);
      this.confirmedUpdateOrder.push(event.envelope.updateId);
      while (this.confirmedUpdateOrder.length > 4096) {
        const removed = this.confirmedUpdateOrder.shift();
        if (removed) this.confirmedUpdates.delete(removed);
      }
    }
    const key = collaborationWorkspaceTextKey(event.envelope);
    const entry = this.entries.get(key);
    if (!entry) {
      return { ...event, handled: false, view: null, authoritativeText: null };
    }
    try {
      const authorityApplied = entry.authorityClient.applyRemoteEnvelope(event.envelope);
      if (authorityApplied.status === 'conflict') {
        this.failEntry(key, entry, {
          code: authorityApplied.recovery?.reason === 'binding_epoch_mismatch'
            ? 'collaboration_text_binding_epoch_mismatch'
            : 'collaboration_text_schema_mismatch',
        });
        return { ...event, handled: true, view: null, authoritativeText: null };
      }
      const applied = entry.client.applyRemoteEnvelope(event.envelope);
      if (applied.status === 'conflict') {
        this.failEntry(key, entry, {
          code: applied.recovery?.reason === 'binding_epoch_mismatch'
            ? 'collaboration_text_binding_epoch_mismatch'
            : 'collaboration_text_schema_mismatch',
        });
        return { ...event, handled: true, view: null, authoritativeText: null };
      }
      entry.authorityClient.advanceBaseRevision(Math.max(
        entry.authorityClient.currentBaseRevision,
        event.revision,
      ));
      this.advanceRevision(event.revision);
      const view = this.view(key, entry);
      return {
        ...event,
        handled: true,
        view,
        authoritativeText: entry.authorityClient.materializedText,
      };
    } catch (error) {
      this.failEntry(key, entry, error);
      throw error;
    }
  }

  advanceRevision(revision: number) {
    if (!this.online || !Number.isSafeInteger(revision) || revision < 1) return;
    for (const [key, entry] of this.entries) {
      try {
        entry.authorityClient.advanceBaseRevision(Math.max(
          entry.authorityClient.currentBaseRevision,
          revision,
        ));
        entry.client.advanceBaseRevision(Math.max(entry.client.currentBaseRevision, revision));
        this.emit(key, entry);
      } catch (error) {
        this.failEntry(key, entry, error);
      }
    }
  }

  invalidateAuthority(error: unknown = { code: 'collaboration_text_revision_conflict' }) {
    if (this.disposed) return;
    this.generation += 1;
    for (const [key, entry] of [...this.entries]) {
      const hasUnacceptedText = entry.client.pendingUpdateCount > 0
        || entry.client.materializedText !== entry.authorityClient.materializedText;
      if (hasUnacceptedText) this.failEntry(key, entry, error);
      else this.removeEntry(key, entry);
    }
    this.nextClientSeq = null;
    this.confirmedUpdates.clear();
    this.confirmedUpdateOrder.length = 0;
  }

  invalidateTarget(
    targetType: CollaborationTextTargetType,
    targetEntityUid: string,
    error: unknown = { code: 'collaboration_text_target_deleted' },
  ) {
    if (this.disposed) return;
    for (const [key, entry] of [...this.entries]) {
      if (entry.descriptor.targetType === targetType
        && entry.descriptor.targetEntityUid === targetEntityUid) {
        this.failEntry(key, entry, error);
      }
    }
  }

  close(
    key: string,
    error: unknown = { code: 'collaboration_text_editor_closed', status: 409 },
  ) {
    const entry = this.entries.get(key);
    if (entry) this.failEntry(key, entry, error);
  }

  clear(error: unknown = { code: 'collaboration_text_registry_cleared', status: 409 }) {
    this.generation += 1;
    for (const [key, entry] of [...this.entries]) this.failEntry(key, entry, error);
    this.nextClientSeq = null;
    this.confirmedUpdates.clear();
    this.confirmedUpdateOrder.length = 0;
  }

  dispose() {
    if (this.disposed) return;
    this.clear();
    this.disposed = true;
    this.online = false;
  }
}

interface Session {
  id?: string;
  projectId: string;
  canvasId: string;
  memberId: string;
  displayName: string;
  role: WorkspaceRole;
  capabilities: WorkspaceCapability[];
  authorizationEpoch: number;
}

function isSafeRotatedParticipantSession(value: unknown, previous: Session): value is Session {
  if (!isPlainRecord(value)
    || typeof value.id !== 'string'
    || !value.id
    || value.id === previous.id
    || value.projectId !== previous.projectId
    || value.canvasId !== previous.canvasId
    || value.memberId !== previous.memberId
    || typeof value.displayName !== 'string'
    || !['owner', 'editor', 'reviewer', 'viewer'].includes(String(value.role))
    || !Array.isArray(value.capabilities)
    || !value.capabilities.every((capability) => typeof capability === 'string')
    || !Number.isSafeInteger(value.authorizationEpoch)
    || Number(value.authorizationEpoch) < 1) return false;
  return true;
}

interface CanvasSummary { id: string; name: string; revision?: number }
type ReviewThread = CollaborationReviewThread;
interface Presence extends CollaborationPresenceValue { memberId: string; displayName: string; connectionId?: string }
interface SubflowPublicationDraft {
  definition: SubflowDefinition;
  baseRevision: number;
  recoveryGeneration: string;
  name: string;
  description: string;
  changeSummary: string;
  conflict?: { revision: number; latestVersion: number; definition: SubflowDefinition };
}
interface ConnectionViewState {
  phase: CollaborationConnectionPhase;
  message: string;
  attempt: number;
}
interface SaveViewState {
  phase: 'saved' | 'pending' | 'saving' | 'blocked';
  message: string;
}

interface CollaborationSyncTask {
  scopeGeneration: number;
  controller: AbortController;
  promise: Promise<boolean>;
}

export interface CollaborationLatestRequestLease {
  signal: AbortSignal;
  isCurrent: () => boolean;
  release: () => void;
}

export class CollaborationLatestRequestFence {
  private generation = 0;

  private controller: AbortController | null = null;

  begin(): CollaborationLatestRequestLease {
    this.controller?.abort();
    const controller = new AbortController();
    const generation = ++this.generation;
    this.controller = controller;
    let released = false;
    return Object.freeze({
      signal: controller.signal,
      isCurrent: () => (
        !released
        && !controller.signal.aborted
        && this.generation === generation
        && this.controller === controller
      ),
      release: () => {
        if (released) return;
        released = true;
        if (this.generation === generation && this.controller === controller) {
          this.controller = null;
        }
      },
    });
  }

  cancel(): void {
    this.generation += 1;
    const controller = this.controller;
    this.controller = null;
    controller?.abort();
  }
}

interface CollaborationRunSyncTask {
  scopeKey: string;
  promise: Promise<void>;
}

const COLLABORATION_RUN_TERMINAL_STATUSES = new Set([
  'succeeded', 'failed', 'stopped', 'interrupted', 'completed', 'rejected', 'cancelled', 'stale',
]);

const COLLABORATION_RUN_EVENT_STATUS: Readonly<Record<string, string>> = Object.freeze({
  'run.queued': 'queued',
  'run.running': 'running',
  'run.succeeded': 'succeeded',
  'run.failed': 'failed',
  'run.stopped': 'stopped',
  'run.interrupted': 'interrupted',
  'node.queued': 'queued',
  'node.started': 'running',
  'node.polling': 'polling',
  'node.output': 'running',
  'node.succeeded': 'succeeded',
  'node.failed': 'failed',
  'node.stopped': 'stopped',
  'node.interrupted': 'interrupted',
});

function boundedCollaborationRunText(value: unknown, maximum = 240) {
  return typeof value === 'string'
    ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maximum)
    : '';
}

function collaborationRunNumber(value: unknown, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function collaborationRunTimestamp(value: unknown) {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : null;
}

function safeCollaborationRunMediaUrl(value: unknown) {
  if (typeof value !== 'string' || !value.trim() || typeof window === 'undefined') return null;
  try {
    const resolved = new URL(value, window.location.origin);
    if (resolved.origin !== window.location.origin
      || !/^\/api\/collab\/assets\/[^/]+\/(?:media|preview|thumbnail)$/.test(resolved.pathname)) return null;
    return `${resolved.pathname}${resolved.search}`;
  } catch {
    return null;
  }
}

function normalizeCollaborationRunUsage(value: unknown): CollaborationRunUsage {
  const record = isPlainRecord(value) ? value : {};
  const result: CollaborationRunUsage = {};
  const keys = ['costUsd', 'inputTokens', 'outputTokens', 'totalTokens', 'durationMs', 'requestCount'] as const;
  for (const key of keys) {
    const numeric = Number(record[key]);
    if (Number.isFinite(numeric) && numeric >= 0) result[key] = numeric;
  }
  return result;
}

function normalizeCollaborationRunError(value: unknown): CollaborationRunError | null {
  const record = isPlainRecord(value) ? value : {};
  const message = boundedCollaborationRunText(record.message ?? value, 1000);
  if (!message) return null;
  const kind = boundedCollaborationRunText(record.kind, 80);
  const code = boundedCollaborationRunText(record.code, 120);
  const httpStatus = Number(record.httpStatus);
  return {
    message,
    ...(kind ? { kind } : {}),
    ...(code ? { code } : {}),
    ...(Number.isSafeInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599 ? { httpStatus } : {}),
    ...(typeof record.retryable === 'boolean' ? { retryable: record.retryable } : {}),
  };
}

function normalizeCollaborationRunAttempt(value: unknown, expectedNodeRunId: string): CollaborationRunAttempt | null {
  if (!isPlainRecord(value)) return null;
  const id = boundedCollaborationRunText(value.id, 240);
  const nodeRunId = boundedCollaborationRunText(value.nodeRunId, 240);
  const status = boundedCollaborationRunText(value.status, 80);
  if (!id || nodeRunId !== expectedNodeRunId || !status) return null;
  const timestamps: Record<string, number> = {};
  const rawTimestamps = isPlainRecord(value.timestamps) ? value.timestamps : {};
  for (const key of ['queuedAt', 'startedAt', 'submittedAt', 'finishedAt', 'updatedAt'] as const) {
    const timestamp = collaborationRunTimestamp(rawTimestamps[key]);
    if (timestamp != null) timestamps[key] = timestamp;
  }
  const provider = boundedCollaborationRunText(value.provider, 160);
  const model = boundedCollaborationRunText(value.model, 240);
  const httpStatus = Number(value.httpStatus);
  return {
    id,
    nodeRunId,
    status,
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(Number.isSafeInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599 ? { httpStatus } : {}),
    pollCount: Math.max(0, Math.trunc(collaborationRunNumber(value.pollCount))),
    timestamps,
    usage: normalizeCollaborationRunUsage(value.usage),
    error: normalizeCollaborationRunError(value.error),
    createdAt: collaborationRunTimestamp(value.createdAt) ?? 0,
    updatedAt: collaborationRunTimestamp(value.updatedAt) ?? 0,
  };
}

function normalizeCollaborationRunNode(value: unknown, expectedRunId: string): CollaborationRunNode | null {
  if (!isPlainRecord(value)) return null;
  const id = boundedCollaborationRunText(value.id, 240);
  const runId = boundedCollaborationRunText(value.runId, 240);
  const nodeId = boundedCollaborationRunText(value.nodeId, 240);
  const status = boundedCollaborationRunText(value.status, 80);
  if (!id || runId !== expectedRunId || !nodeId || !status) return null;
  const attempts = Array.isArray(value.attempts)
    ? value.attempts.slice(-200)
      .map((attempt) => normalizeCollaborationRunAttempt(attempt, id))
      .filter((attempt): attempt is CollaborationRunAttempt => Boolean(attempt))
    : undefined;
  const parentNodeRunId = boundedCollaborationRunText(value.parentNodeRunId, 240);
  return {
    id,
    runId,
    nodeId,
    ...(parentNodeRunId ? { parentNodeRunId } : {}),
    status,
    outputRefs: Array.isArray(value.outputRefs)
      ? [...new Set(value.outputRefs.map((item) => boundedCollaborationRunText(item, 240)).filter(Boolean))].slice(0, 1000)
      : [],
    updatedAt: collaborationRunTimestamp(value.updatedAt) ?? 0,
    ...(attempts ? { attempts } : {}),
  };
}

function normalizeCollaborationRunAsset(value: unknown): CollaborationRunAsset | null {
  if (!isPlainRecord(value)) return null;
  const id = boundedCollaborationRunText(value.id, 240);
  if (!id) return null;
  const contentRevision = Number(value.contentRevision);
  return {
    id,
    kind: boundedCollaborationRunText(value.kind, 80) || 'other',
    filename: boundedCollaborationRunText(value.filename, 300) || 'asset',
    mimeType: boundedCollaborationRunText(value.mimeType, 160) || 'application/octet-stream',
    ...(Number.isSafeInteger(contentRevision) && contentRevision >= 1 ? { contentRevision } : {}),
    mediaUrl: safeCollaborationRunMediaUrl(value.mediaUrl),
    thumbnailUrl: safeCollaborationRunMediaUrl(value.thumbnailUrl),
  };
}

export function normalizeCollaborationRun(
  value: unknown,
  expectedCanvasId: string,
  observedAt = Date.now(),
): CollaborationRun | null {
  if (!isPlainRecord(value)) return null;
  const id = boundedCollaborationRunText(value.id, 240);
  const canvasId = boundedCollaborationRunText(value.canvasId, 240);
  const status = boundedCollaborationRunText(value.status, 80);
  const initiatorId = boundedCollaborationRunText(value.initiatorId, 240);
  const canvasRevision = Number(value.canvasRevision);
  if (!id || canvasId !== expectedCanvasId || !status || !initiatorId
    || !Number.isSafeInteger(canvasRevision) || canvasRevision < 0) return null;
  const nodes = Array.isArray(value.nodes)
    ? value.nodes.slice(0, 500)
      .map((node) => normalizeCollaborationRunNode(node, id))
      .filter((node): node is CollaborationRunNode => Boolean(node))
    : [];
  const assets = Array.isArray(value.assets)
    ? value.assets.slice(0, 1000)
      .map(normalizeCollaborationRunAsset)
      .filter((asset): asset is CollaborationRunAsset => Boolean(asset))
    : [];
  const createdAt = collaborationRunTimestamp(value.createdAt) ?? 0;
  const startedAt = collaborationRunTimestamp(value.startedAt);
  const finishedAt = collaborationRunTimestamp(value.finishedAt);
  const parentRunId = boundedCollaborationRunText(value.parentRunId, 240);
  return {
    id,
    canvasId,
    canvasRevision,
    status,
    ...(parentRunId ? { parentRunId } : {}),
    initiatorId,
    createdAt,
    startedAt,
    finishedAt,
    updatedAt: Math.max(createdAt, startedAt || 0, finishedAt || 0, collaborationRunTimestamp(observedAt) || 0),
    nodes,
    assets,
  };
}

export function normalizeCollaborationRunEvent(value: unknown): CollaborationRunEvent | null {
  if (!isPlainRecord(value)) return null;
  const id = Number(value.id);
  const runId = boundedCollaborationRunText(value.runId, 240);
  const nodeRunId = boundedCollaborationRunText(value.nodeRunId, 240);
  const type = boundedCollaborationRunText(value.type, 120);
  const createdAt = collaborationRunTimestamp(value.createdAt);
  if (!Number.isSafeInteger(id) || id < 1 || !runId || !type || createdAt == null) return null;
  const rawPayload = isPlainRecord(value.payload) ? value.payload : {};
  const payload: Record<string, unknown> = {};
  const payloadStatus = boundedCollaborationRunText(rawPayload.status, 80);
  const payloadNodeId = boundedCollaborationRunText(rawPayload.nodeId, 240);
  const payloadPercent = Number(rawPayload.percent);
  const payloadProgress = Number(rawPayload.progress);
  if (payloadStatus) payload.status = payloadStatus;
  if (payloadNodeId) payload.nodeId = payloadNodeId;
  if (Number.isFinite(payloadPercent)) payload.percent = Math.max(0, Math.min(100, payloadPercent));
  if (Number.isFinite(payloadProgress)) {
    payload.progress = Math.max(0, Math.min(100, payloadProgress >= 0 && payloadProgress <= 1
      ? payloadProgress * 100
      : payloadProgress));
  }
  return {
    id,
    runId,
    ...(nodeRunId ? { nodeRunId } : {}),
    type,
    payload,
    createdAt,
  };
}

export function mergeCollaborationRun(
  existing: CollaborationRun | undefined,
  incoming: CollaborationRun,
): CollaborationRun {
  if (!existing || existing.canvasId !== incoming.canvasId) return incoming;
  const incomingIsCurrent = incoming.updatedAt >= existing.updatedAt;
  const nodeMap = new Map(existing.nodes.map((node) => [node.id, node]));
  for (const node of incoming.nodes) {
    const previous = nodeMap.get(node.id);
    nodeMap.set(node.id, previous ? {
      ...previous,
      ...node,
      progressPercent: node.progressPercent ?? previous.progressPercent,
      ...(!node.attempts && previous.attempts ? { attempts: previous.attempts } : {}),
      updatedAt: Math.max(previous.updatedAt, node.updatedAt),
    } : node);
  }
  const assetMap = new Map(existing.assets.map((asset) => [asset.id, asset]));
  for (const asset of incoming.assets) assetMap.set(asset.id, { ...assetMap.get(asset.id), ...asset });
  return {
    ...existing,
    ...(incomingIsCurrent ? incoming : {}),
    nodes: [...nodeMap.values()],
    assets: [...assetMap.values()],
    updatedAt: Math.max(existing.updatedAt, incoming.updatedAt),
  };
}

export function mergeCollaborationRunEvent(
  current: Record<string, CollaborationRun>,
  event: CollaborationRunEvent,
  canvasId: string,
): Record<string, CollaborationRun> {
  const existing = current[event.runId] || {
    id: event.runId,
    canvasId,
    canvasRevision: 0,
    status: 'queued',
    initiatorId: 'host',
    createdAt: event.createdAt,
    updatedAt: event.createdAt,
    nodes: [],
    assets: [],
  };
  const mappedStatus = COLLABORATION_RUN_EVENT_STATUS[event.type];
  if (!event.nodeRunId) {
    const status = mappedStatus || boundedCollaborationRunText(event.payload.status, 80) || existing.status;
    return {
      ...current,
      [event.runId]: mergeCollaborationRun(existing, {
        ...existing,
        status,
        updatedAt: Math.max(existing.updatedAt, event.createdAt),
      }),
    };
  }
  const nodes = existing.nodes.map((node) => ({ ...node }));
  const index = nodes.findIndex((node) => node.id === event.nodeRunId);
  const eventNodeId = boundedCollaborationRunText(event.payload.nodeId, 240) || event.nodeRunId;
  const progressValue = Number(event.payload.percent ?? event.payload.progress);
  const progressPercent = Number.isFinite(progressValue)
    ? Math.max(0, Math.min(100, progressValue))
    : undefined;
  const previous = index >= 0 ? nodes[index] : undefined;
  const nextNode: CollaborationRunNode = {
    ...(previous || {
      id: event.nodeRunId,
      runId: event.runId,
      nodeId: eventNodeId,
      outputRefs: [],
      status: mappedStatus || 'queued',
      updatedAt: event.createdAt,
    }),
    status: mappedStatus || boundedCollaborationRunText(event.payload.status, 80) || previous?.status || 'queued',
    ...(progressPercent == null ? {} : { progressPercent }),
    updatedAt: Math.max(previous?.updatedAt || 0, event.createdAt),
  };
  if (index >= 0) nodes[index] = nextNode;
  else nodes.push(nextNode);
  return {
    ...current,
    [event.runId]: {
      ...existing,
      nodes,
      updatedAt: Math.max(existing.updatedAt, event.createdAt),
    },
  };
}

export function normalizeCollaborationRunIntentView(
  value: unknown,
  expectedCanvasId: string,
): CollaborationRunIntentView | null {
  if (!isPlainRecord(value)) return null;
  const id = boundedCollaborationRunText(value.id, 240);
  const canvasId = boundedCollaborationRunText(value.canvasId, 240);
  const requestedBy = boundedCollaborationRunText(value.requestedBy, 240);
  const status = boundedCollaborationRunText(value.status, 80);
  const canvasRevision = Number(value.canvasRevision);
  if (!id || canvasId !== expectedCanvasId || !requestedBy || !status
    || !Number.isSafeInteger(canvasRevision) || canvasRevision < 0) return null;
  const queueRevision = Number(value.queueRevision);
  const dispatchAttempts = Number(value.dispatchAttempts);
  const numericOrNull = (input: unknown) => collaborationRunTimestamp(input);
  const lastErrorRecord = isPlainRecord(value.lastError) ? value.lastError : {};
  const lastErrorCode = boundedCollaborationRunText(lastErrorRecord.code ?? value.lastErrorCode, 120);
  const lastErrorMessage = boundedCollaborationRunText(lastErrorRecord.message ?? value.lastErrorMessage, 1000);
  return {
    id,
    canvasId,
    canvasRevision,
    requestedBy,
    nodeIds: Array.isArray(value.nodeIds)
      ? [...new Set(value.nodeIds.map((item) => boundedCollaborationRunText(item, 240)).filter(Boolean))].slice(0, 500)
      : [],
    status,
    runId: boundedCollaborationRunText(value.runId, 240) || null,
    estimatedCostKnown: value.estimatedCostKnown === true,
    estimatedCost: value.estimatedCostKnown === true && Number.isFinite(Number(value.estimatedCost))
      ? Math.max(0, Number(value.estimatedCost)) : null,
    actualCost: value.actualCost != null && Number.isFinite(Number(value.actualCost))
      ? Math.max(0, Number(value.actualCost)) : null,
    ...(Number.isSafeInteger(queueRevision) && queueRevision >= 1 ? { queueRevision } : {}),
    ...(typeof value.confirmationRequired === 'boolean' ? { confirmationRequired: value.confirmationRequired } : {}),
    ...(Number.isSafeInteger(dispatchAttempts) && dispatchAttempts >= 0 ? { dispatchAttempts } : {}),
    nextAttemptAt: numericOrNull(value.nextAttemptAt),
    leaseExpiresAt: numericOrNull(value.leaseExpiresAt),
    cancelRequestedAt: numericOrNull(value.cancelRequestedAt),
    cancelledAt: numericOrNull(value.cancelledAt),
    lastError: lastErrorCode || lastErrorMessage ? { code: lastErrorCode || null, message: lastErrorMessage || null } : null,
    createdAt: numericOrNull(value.createdAt) ?? 0,
    updatedAt: numericOrNull(value.updatedAt) ?? 0,
  };
}

export function collaborationRunScopeKey(
  value: Pick<Session, 'id' | 'projectId' | 'canvasId' | 'memberId' | 'authorizationEpoch'>,
  recoveryGeneration: unknown,
) {
  const normalizedRecoveryGeneration = normalizeCollaborationRecoveryGeneration(recoveryGeneration);
  if (!normalizedRecoveryGeneration) return '';
  return [
    value.id || '',
    value.projectId,
    value.canvasId,
    value.memberId,
    value.authorizationEpoch,
    normalizedRecoveryGeneration,
  ].join('\u0001');
}

function withMergedCollaborationRun(
  current: Record<string, CollaborationRun>,
  incoming: CollaborationRun,
) {
  const next = {
    ...current,
    [incoming.id]: mergeCollaborationRun(current[incoming.id], incoming),
  };
  return boundedCollaborationRuns(next);
}

function boundedCollaborationRuns(current: Record<string, CollaborationRun>) {
  const retainedIds = new Set(Object.values(current)
    .sort((left, right) => right.updatedAt - left.updatedAt || right.createdAt - left.createdAt || left.id.localeCompare(right.id))
    .slice(0, 50)
    .map((run) => run.id));
  return Object.fromEntries(Object.entries(current).filter(([runId]) => retainedIds.has(runId)));
}

function mergeCollaborationRunIntentView(
  existing: CollaborationRunIntentView | undefined,
  incoming: CollaborationRunIntentView,
) {
  if (!existing || incoming.updatedAt >= existing.updatedAt
    || Number(incoming.queueRevision || 0) >= Number(existing.queueRevision || 0)) {
    return {
      ...existing,
      ...incoming,
      nodeIds: incoming.nodeIds.length ? incoming.nodeIds : existing?.nodeIds || [],
    };
  }
  return existing;
}

function collaborationRunProgress(run: CollaborationRun) {
  const total = run.nodes.length;
  const terminal = run.nodes.filter((node) => COLLABORATION_RUN_TERMINAL_STATUSES.has(node.status)).length;
  const percent = total > 0
    ? Math.round(run.nodes.reduce((sum, node) => (
      sum + (COLLABORATION_RUN_TERMINAL_STATUSES.has(node.status)
        ? 100
        : Number.isFinite(node.progressPercent) ? Number(node.progressPercent) : 0)
    ), 0) / total)
    : (COLLABORATION_RUN_TERMINAL_STATUSES.has(run.status) ? 100 : 0);
  return { total, terminal, percent: Math.max(0, Math.min(100, percent)) };
}

function formatCollaborationRunTime(value?: number | null) {
  return value && Number.isFinite(value) ? new Date(value).toLocaleString() : '—';
}

function collaborationRunUsageEntries(usage: CollaborationRunUsage) {
  const labels: Record<keyof CollaborationRunUsage, string> = {
    costUsd: '费用 USD',
    inputTokens: '输入 token',
    outputTokens: '输出 token',
    totalTokens: '总 token',
    durationMs: '耗时 ms',
    requestCount: '请求数',
  };
  return (Object.keys(labels) as Array<keyof CollaborationRunUsage>)
    .filter((key) => Number.isFinite(usage[key]))
    .map((key) => [labels[key], Number(usage[key])] as const);
}

const COLLABORATION_RECOVERY_GENERATION_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function normalizeCollaborationRecoveryGeneration(value: unknown) {
  return typeof value === 'string' && COLLABORATION_RECOVERY_GENERATION_PATTERN.test(value)
    ? value.toLowerCase()
    : null;
}

interface CollaborationRequestOptions {
  timeoutMs?: number;
  onResponse?: (response: Response) => void;
  /** Mutation callers must pass an immutable captured generation explicitly. */
  recoveryGeneration?: string | null;
  assertCurrent?: () => void;
}

export async function collabEnvelopeRequest<T>(
  url: string,
  init: RequestInit = {},
  options: CollaborationRequestOptions = {},
): Promise<CollaborationReviewApiEnvelope<T>> {
  const controller = new AbortController();
  const sourceSignal = init.signal;
  let timedOut = false;
  const abortFromSource = () => controller.abort();
  if (sourceSignal?.aborted) controller.abort();
  else sourceSignal?.addEventListener('abort', abortFromSource, { once: true });
  const timeoutMs = Math.max(1, options.timeoutMs ?? COLLABORATION_REQUEST_TIMEOUT_MS);
  const timeout = window.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    options.assertCurrent?.();
    const method = String(init.method || 'GET').toUpperCase();
    const headers = new Headers(init.headers);
    const requestedRecoveryGeneration = normalizeCollaborationRecoveryGeneration(
      options.recoveryGeneration,
    );
    if (options.recoveryGeneration != null && !requestedRecoveryGeneration) {
      throw Object.assign(new Error('协作 mutation recovery generation 无效'), {
        code: 'collaboration_mutation_generation_invalid',
      });
    }
    if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && requestedRecoveryGeneration) {
      const suppliedRecoveryGeneration = headers.has('X-T8-Canvas-Generation')
        ? normalizeCollaborationRecoveryGeneration(headers.get('X-T8-Canvas-Generation'))
        : requestedRecoveryGeneration;
      if (suppliedRecoveryGeneration !== requestedRecoveryGeneration) {
        throw Object.assign(new Error('协作 mutation recovery generation 与已捕获作用域不一致'), {
          code: 'collaboration_mutation_generation_mismatch',
        });
      }
      headers.set('X-T8-Canvas-Generation', requestedRecoveryGeneration);
    }
    const response = await fetch(url, {
      ...init,
      credentials: 'same-origin',
      headers,
      signal: controller.signal,
    });
    options.assertCurrent?.();
    options.onResponse?.(response);
    const contentType = String(response.headers.get('content-type') || '').toLowerCase();
    const raw = contentType.includes('json')
      ? await response.json().catch(() => ({}))
      : await response.text().catch(() => '');
    options.assertCurrent?.();
    const payload: Record<string, unknown> = isPlainRecord(raw) ? raw : { data: raw };
    if (!response.ok) {
      const errorMessage = typeof payload.error === 'string'
        ? payload.error
        : typeof payload.message === 'string' ? payload.message : `HTTP ${response.status}`;
      throw Object.assign(new Error(errorMessage), {
        status: response.status,
        code: payload.code,
        currentRevision: payload.currentRevision,
        details: payload.details,
        bindingEpoch: payload.bindingEpoch,
        data: payload,
      });
    }
    return {
      data: (Object.hasOwn(payload, 'data') ? payload.data : payload) as T,
      ...(isPlainRecord(payload.meta) ? { meta: payload.meta } : {}),
    };
  } catch (error) {
    if (timedOut) {
      throw Object.assign(new Error(`协作请求超时（${Math.round(timeoutMs / 1000)} 秒）`), {
        code: 'collaboration_request_timeout',
      });
    }
    throw error;
  } finally {
    window.clearTimeout(timeout);
    sourceSignal?.removeEventListener('abort', abortFromSource);
  }
}

async function collabRequest<T>(
  url: string,
  init: RequestInit = {},
  options: CollaborationRequestOptions = {},
): Promise<T> {
  return (await collabEnvelopeRequest<T>(url, init, options)).data;
}

export type CollaborationTextBindingLoadResult = {
  kind: 'binding';
  snapshot: CollaborationTextBindingSnapshot;
  nextClientSeq: number;
} | {
  kind: 'recovery';
  recovery: CollaborationTextLegacyRecoveryModel;
};

function assertCollaborationTextLoadCurrent(
  signal?: AbortSignal,
  isCurrentScope: () => boolean = () => true,
) {
  if (!signal?.aborted && isCurrentScope()) return;
  throw Object.assign(new Error('协同文本绑定载入已取消'), { name: 'AbortError' });
}

export function safeCollaborationTextBindingStatus(error: unknown) {
  const record = collaborationTextAuthorityErrorRecord(error);
  const status = Number(record.status);
  const code = String(record.code || '');
  if (status === 401 || status === 403 || code === 'collaboration_text_permission_denied') {
    return '当前会话无权读取该协同文本字段或其旧正文恢复内容。';
  }
  if (status === 404 || code === 'collaboration_text_recovery_unavailable') {
    return '该协同文本字段或旧正文恢复内容当前不可用。';
  }
  if (code === 'collaboration_text_recovery_invalid') {
    return '主机返回的旧协同文本恢复响应未通过安全校验。';
  }
  return error instanceof Error ? error.message : String(error);
}

export async function loadCollaborationTextBinding(
  scopedCanvasId: string,
  scopedProjectId: string,
  descriptor: Pick<CollaborationWorkspaceTextDescriptor, 'targetType' | 'targetEntityUid' | 'field'>,
  options: {
    signal?: AbortSignal;
    isCurrentScope?: () => boolean;
    authoritativeText?: string;
  } = {},
): Promise<CollaborationTextBindingLoadResult> {
  const { signal, isCurrentScope = () => true, authoritativeText } = options;
  assertCollaborationTextLoadCurrent(signal, isCurrentScope);
  const query = new URLSearchParams({
    targetType: descriptor.targetType,
    targetEntityUid: descriptor.targetEntityUid,
    field: descriptor.field,
  });
  let nextClientSeq = Number.NaN;
  try {
    const snapshot = await collabRequest<CollaborationTextBindingSnapshot>(
      `/api/collab/canvases/${encodeURIComponent(scopedCanvasId)}/text?${query}`,
      { signal },
      {
        onResponse: (response) => {
          const value = response.headers.get('x-t8-text-next-client-seq');
          nextClientSeq = value != null && /^(?:0|[1-9]\d*)$/.test(value)
            ? Number(value)
            : Number.NaN;
        },
      },
    );
    assertCollaborationTextLoadCurrent(signal, isCurrentScope);
    if (!Number.isSafeInteger(nextClientSeq) || nextClientSeq < 0) {
      throw textProtocolError(
        'collaboration_text_client_seq_invalid',
        '协同文本绑定缺少下一客户端序号',
      );
    }
    return { kind: 'binding', snapshot, nextClientSeq };
  } catch (error) {
    assertCollaborationTextLoadCurrent(signal, isCurrentScope);
    const record = collaborationTextAuthorityErrorRecord(error);
    const details = isPlainRecord(record.details) ? record.details : null;
    if (record.code !== 'collaboration_text_schema_mismatch'
      || details?.recoveryAvailable !== true) throw error;
    const rawRecovery = await collabRequest<unknown>(
      `/api/collab/canvases/${encodeURIComponent(scopedCanvasId)}/text/recovery?${query}`,
      { signal },
    );
    assertCollaborationTextLoadCurrent(signal, isCurrentScope);
    const recovery = await normalizeCollaborationTextLegacyRecovery(rawRecovery, {
      projectId: scopedProjectId,
      canvasId: scopedCanvasId,
      ...descriptor,
      ...(authoritativeText != null ? { authoritativeText } : {}),
    });
    assertCollaborationTextLoadCurrent(signal, isCurrentScope);
    return { kind: 'recovery', recovery };
  }
}

export async function submitCollaborationTextUpdate(
  envelope: CollaborationTextUpdateEnvelope,
  assertCurrentScope: () => void,
  options: Pick<CollaborationRequestOptions, 'recoveryGeneration'> = {},
): Promise<CollaborationTextSubmissionResult> {
  const normalized = normalizeCollaborationTextUpdateEnvelope(envelope);
  const body = JSON.stringify(normalized);
  const url = `/api/collab/canvases/${encodeURIComponent(normalized.canvasId)}/text/updates`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      let noOp: boolean | null = null;
      const data = await collabRequest<unknown>(
        url,
        { method: 'POST', body },
        {
          recoveryGeneration: options.recoveryGeneration,
          assertCurrent: assertCurrentScope,
          onResponse: (response) => {
            if (!response.ok) return;
            const value = response.headers.get('x-t8-collaboration-text-noop');
            if (value !== '0' && value !== '1') {
              throw textProtocolError(
                'collaboration_text_transport_invalid',
                '协同文本响应的 no-op 标记无效',
              );
            }
            noOp = value === '1';
          },
        },
      );
      if (noOp == null) {
        throw textProtocolError(
          'collaboration_text_transport_invalid',
          '协同文本响应缺少 no-op 标记',
        );
      }
      return { data, noOp };
    } catch (error) {
      if (attempt > 0 || isDefinitiveCollaborationOperationRejection(error)) throw error;
    }
  }
  throw textProtocolError('collaboration_text_dispatch_failed', '协同文本更新提交失败');
}

function displayNode(node: Node): Node {
  const originalType = String(node.type || 'unknown');
  const data = (node.data || {}) as Record<string, unknown>;
  const label = String(data.title || data.label || data.name || `${originalType} · ${node.id.slice(-8)}`);
  const ports = resolveNodeConnectionPorts(node);
  return {
    ...node,
    type: 'collaborationPreview',
    data: {
      ...data,
      label,
      __collaborationOriginalType: originalType,
      __collaborationPorts: ports.resolved ? ports : null,
    },
    style: {
      width: Math.max(180, Number(node.width || node.measured?.width || 220)),
      minHeight: 64,
      border: '2px solid var(--border-primary)',
      borderRadius: 6,
      background: 'var(--bg-secondary)',
      color: 'var(--text-primary)',
      fontSize: 12,
      ...(node.style || {}),
    },
  };
}

function CollaborationPreviewNode({ data, selected }: NodeProps<Node<Record<string, unknown>>>) {
  const ports = data.__collaborationPorts as ResolvedNodeConnectionPorts | null;
  const remoteDrag = data.__collaborationRemoteDrag === true;
  const renderHandles = (
    items: ResolvedNodeConnectionPorts['inputs'],
    type: 'target' | 'source',
    position: Position,
  ) => items.map((port, index) => (
    <Handle
      key={`${type}:${port.id ?? 'default'}`}
      id={port.id ?? undefined}
      type={type}
      position={position}
      title={`${port.id ?? 'default'} · ${port.kinds.join('/')}`}
      style={{
        top: `${((index + 1) / (items.length + 1)) * 100}%`,
        width: 10,
        height: 10,
        background: PORT_COLOR[port.kinds[0] || 'any'],
        border: '1px solid var(--bg-primary)',
      }}
    />
  ));
  return (
    <div
      className={`relative min-h-14 min-w-44 rounded px-3 py-2 ${remoteDrag ? 'border-2 border-dashed border-[var(--accent-primary)] opacity-75' : selected ? 'ring-2 ring-[var(--accent-primary)]' : ''}`}
      data-remote-drag={remoteDrag ? 'true' : 'false'}
    >
      {ports ? renderHandles(ports.inputs, 'target', Position.Left) : null}
      <div className="truncate text-[10px] font-bold">{String(data.label || '节点')}</div>
      <div className="mt-1 truncate text-[9px] opacity-55">{String(data.__collaborationOriginalType || 'unknown')}</div>
      {remoteDrag && <div className="mt-1 text-[8px] font-semibold text-[var(--accent-primary)]">协作者正在移动</div>}
      {ports ? renderHandles(ports.outputs, 'source', Position.Right) : null}
    </div>
  );
}

const COLLABORATION_NODE_TYPES = { collaborationPreview: CollaborationPreviewNode };

function originalCollaborationNode(node: Node): Node {
  const data = (node.data || {}) as Record<string, unknown>;
  const {
    __collaborationOriginalType,
    __collaborationPorts: _ports,
    __collaborationRemoteDrag: _remoteDrag,
    ...originalData
  } = data;
  return {
    ...node,
    type: String(__collaborationOriginalType || node.type || 'unknown'),
    data: originalData,
  };
}

function requestedCanvasIdFromLocation() {
  return new URLSearchParams(location.search).get('canvas') || '';
}

function removeInviteFromAddressBar() {
  const url = new URL(location.href);
  if (!url.searchParams.has('invite')) return;
  url.searchParams.delete('invite');
  history.replaceState(history.state, '', `${url.pathname}${url.search}${url.hash}`);
}

function collaborationQueueScope(
  session: Session,
  recoveryGeneration: string | null,
): CollaborationQueueScope | null {
  const normalizedRecoveryGeneration = normalizeCollaborationRecoveryGeneration(recoveryGeneration);
  if (!session.id
    || !Number.isSafeInteger(session.authorizationEpoch)
    || session.authorizationEpoch < 1
    || !normalizedRecoveryGeneration) return null;
  return {
    projectId: session.projectId,
    canvasId: session.canvasId,
    memberId: session.memberId,
    sessionId: session.id,
    role: session.role,
    authorizationEpoch: session.authorizationEpoch,
    recoveryGeneration: normalizedRecoveryGeneration,
  };
}

interface CollaborationMutationFence {
  projectId: string;
  canvasId: string;
  memberId: string;
  sessionId: string;
  authorizationEpoch: number;
  recoveryGeneration: string;
  scopeGeneration: number;
}

function collaborationMutationScopeChangedError() {
  return Object.assign(new Error('协作 mutation 所属 recovery generation 或授权 epoch 已变化'), {
    code: 'collaboration_mutation_scope_changed',
    status: 409,
  });
}

function collaborationPresenceKey(memberId: unknown, connectionId: unknown) {
  const normalizedConnectionId = String(connectionId || '').trim();
  return normalizedConnectionId || `member:${String(memberId || '').trim()}`;
}

function saveViewForQueue(
  queue: CollaborationQueueItem[],
  savedRevision?: number,
): SaveViewState {
  const blocked = queue.filter((item) => item.status === 'blocked').length;
  if (blocked > 0) {
    return {
      phase: 'blocked',
      message: `${blocked} 条操作需要人工重试或丢弃；严格 FIFO 已暂停自动重放`,
    };
  }
  const inflight = queue.filter((item) => item.status === 'inflight').length;
  if (inflight > 0) {
    return { phase: 'saving', message: `正在提交 ${inflight} 条画布移动` };
  }
  if (queue.length > 0) {
    return { phase: 'pending', message: `${queue.length} 条画布移动待提交` };
  }
  return {
    phase: 'saved',
    message: savedRevision == null ? '没有待提交操作' : `已保存 revision ${savedRevision}`,
  };
}

function isDefinitiveCollaborationOperationRejection(error: unknown) {
  const status = Number((error as { status?: unknown })?.status);
  return Number.isInteger(status)
    && status >= 400
    && status < 500
    && ![408, 425, 429].includes(status);
}

function availableLocalStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function availableSessionStorage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function displayNodesWithQueuedMoves(
  document: VersionedCanvasData,
  queue: CollaborationQueueItem[],
  presences: Iterable<CollaborationPresenceValue> = [],
  localDrags: Iterable<CollaborationDragPreview> = [],
) {
  const overrides = pendingNodeMoveOverrides(queue);
  const localPositions = new Map(
    [...localDrags].map((drag) => [drag.nodeId, drag.position] as const),
  );
  const excluded = new Set([...localPositions.keys(), ...overrides.keys()]);
  const remotePositions = collaborationRemoteDragPositions(document, presences, excluded);
  return document.nodes.map((node) => displayNode({
    ...node,
    ...(localPositions.has(String(node.id)) ? { position: localPositions.get(String(node.id))! }
      : overrides.has(String(node.id)) ? { position: overrides.get(String(node.id))! }
      : remotePositions.has(String(node.id)) ? { position: remotePositions.get(String(node.id))! }
        : {}),
    ...(remotePositions.has(String(node.id))
      ? { data: { ...(node.data || {}), __collaborationRemoteDrag: true } }
      : {}),
  }));
}

function Workspace() {
  const [session, setSession] = useState<Session | null>(null);
  const [canvases, setCanvases] = useState<CanvasSummary[]>([]);
  const [document, setDocument] = useState<VersionedCanvasData | null>(null);
  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [selectedNodeId, setSelectedNodeId] = useState('');
  const [reviews, setReviews] = useState<ReviewThread[]>([]);
  const [reviewRefreshToken, setReviewRefreshToken] = useState(0);
  const [textViews, setTextViews] = useState<Record<string, CollaborationWorkspaceTextView>>({});
  const [textConflicts, setTextConflicts] = useState<CollaborationTextConflictItem[]>([]);
  const [editingReviewTextKey, setEditingReviewTextKey] = useState('');
  const [textBindingReload, setTextBindingReload] = useState(0);
  const [presence, setPresence] = useState<Record<string, Presence>>({});
  const [sharedRuns, setSharedRuns] = useState<Record<string, CollaborationRun>>({});
  const [ownRunIntents, setOwnRunIntents] = useState<Record<string, CollaborationRunIntentView>>({});
  const [selectedSharedRunId, setSelectedSharedRunId] = useState('');
  const [sharedRunCursor, setSharedRunCursor] = useState(0);
  const [sharedRunDetailLoadingId, setSharedRunDetailLoadingId] = useState('');
  const [runIntentCancellingId, setRunIntentCancellingId] = useState('');
  const [sharedRunError, setSharedRunError] = useState('');
  const [subflows, setSubflows] = useState<SubflowDefinition[]>([]);
  const [subflowDraft, setSubflowDraft] = useState<SubflowPublicationDraft | null>(null);
  const [status, setStatus] = useState('正在连接协作网关…');
  const [connectionState, setConnectionState] = useState<ConnectionViewState>({
    phase: 'bootstrapping',
    message: '正在验证协作会话并载入画布…',
    attempt: 0,
  });
  const [saveState, setSaveState] = useState<SaveViewState>({ phase: 'saved', message: '没有待提交操作' });
  const [offlineQueue, setOfflineQueue] = useState<CollaborationQueueItem[]>([]);
  const [queueScopeVersion, setQueueScopeVersion] = useState(0);
  const [structureBusy, setStructureBusy] = useState(false);
  const [busy, setBusy] = useState(true);
  const [participantSessionAction, setParticipantSessionAction] = useState<'rotate' | 'logout' | null>(null);
  const [participantSessionConfirmation, setParticipantSessionConfirmation] = useState<'rotate' | 'logout' | null>(null);
  const [displayName, setDisplayName] = useState(() => localStorage.getItem('t8-collab-display-name') || `访客-${Math.random().toString(36).slice(2, 6)}`);
  const [runIntentRecoveryRetry, setRunIntentRecoveryRetry] = useState(0);
  const webSocketRef = useRef<WebSocket | null>(null);
  const runIntentSubmittingKeysRef = useRef(new Set<string>());
  const runIntentRecoveryAttemptedRef = useRef('');
  const runIntentRecoveryScopeRef = useRef('');
  const runIntentRecoveryTimerRef = useRef<number | null>(null);
  const sessionRef = useRef<Session | null>(null);
  const authoritativeDocumentRef = useRef<VersionedCanvasData | null>(null);
  const authoritativeGenerationRef = useRef<string | null>(null);
  const connectionStateRef = useRef(connectionState);
  const textRegistryRef = useRef<CollaborationWorkspaceTextRegistry | null>(null);
  const textScopeRef = useRef('');
  const textRecoveryScopeRef = useRef('');
  const textConflictVaultRef = useRef(new CollaborationTextConflictScopeVault());
  const textMaterializedRevisionRef = useRef(new Map<string, number>());
  const textDismissedRecoveryIdsRef = useRef(new Set<string>());
  const textDismissedRecoveryIdsByScopeRef = useRef(new Map<string, Set<string>>());
  const reviewTextLoadFenceRef = useRef<CollaborationLatestRequestFence | null>(null);
  if (!reviewTextLoadFenceRef.current) {
    reviewTextLoadFenceRef.current = new CollaborationLatestRequestFence();
  }
  const textAuthorityRecoveryRef = useRef<(revision: number) => Promise<boolean>>(async () => false);
  const textAcceptedRef = useRef<(
    result: CollaborationTextMutationResult,
    envelope: CollaborationTextUpdateEnvelope,
  ) => void>(() => undefined);
  const offlineQueueRef = useRef<CollaborationQueueItem[]>([]);
  const queueScopeRef = useRef<CollaborationQueueScope | null>(null);
  const queueStorageKeyRef = useRef('');
  const queueScopeGenerationRef = useRef(0);
  const bootstrapStartedRef = useRef(false);
  const queueRestoreRejectedRef = useRef(0);
  const canvasRecoveryRef = useRef<(revision?: number) => Promise<boolean>>(async () => false);
  const syncTaskRef = useRef<CollaborationSyncTask | null>(null);
  const collaborationRunEventCursorRef = useRef(0);
  const collaborationRunSyncTaskRef = useRef<CollaborationRunSyncTask | null>(null);
  const collaborationRunInitializationRef = useRef<CollaborationRunSyncTask | null>(null);
  const collaborationRunDetailGenerationRef = useRef(new Map<string, number>());
  const syncHighWaterRef = useRef(0);
  const maxSyncOperationsRef = useRef(COLLABORATION_SYNC_MAX_OPERATIONS);
  const flushPromiseRef = useRef<Promise<void> | null>(null);
  const failedQueueTransitionRef = useRef<{
    scopeGeneration: number;
    queue: CollaborationQueueItem[];
  } | null>(null);
  const socketGenerationRef = useRef(0);
  const sessionHeartbeatGenerationRef = useRef(0);
  const sessionHeartbeatSingleFlightRef = useRef<CollaborationSessionHeartbeatSingleFlight | null>(null);
  const sessionHeartbeatSingleFlight = sessionHeartbeatSingleFlightRef.current
    ?? new CollaborationSessionHeartbeatSingleFlight();
  sessionHeartbeatSingleFlightRef.current = sessionHeartbeatSingleFlight;
  const retryConnectionRef = useRef<(() => void) | null>(null);
  const localPresenceRef = useRef<CollaborationPresenceValue>({});
  const presenceRef = useRef<Record<string, Presence>>({});
  const localDragRef = useRef<(CollaborationDragPreview & {
    finalCommitted: boolean;
    lastSentAt: number;
  }) | null>(null);
  const structureMutationTailRef = useRef<Promise<void>>(Promise.resolve());
  const clientInstanceIdRef = useRef('');
  if (!clientInstanceIdRef.current) {
    clientInstanceIdRef.current = createCanvasEntityUid();
  }
  const seqRef = useRef(1);
  const pointerSentAtRef = useRef(0);
  sessionRef.current = session;
  connectionStateRef.current = connectionState;
  offlineQueueRef.current = offlineQueue;
  presenceRef.current = presence;
  const canvasId = session?.canvasId || '';
  const renderedQueueScope = session
    ? collaborationQueueScope(session, authoritativeGenerationRef.current)
    : null;
  const currentRecoveryGeneration = normalizeCollaborationRecoveryGeneration(
    authoritativeGenerationRef.current,
  ) || '';
  const queueScopeReady = sameCollaborationQueueScope(renderedQueueScope, queueScopeRef.current);
  const socketScopeReady = Boolean(
    session
    && document?.canvasId === session.canvasId
    && queueScopeReady,
  );
  const canEdit = session?.capabilities.includes('editGraph') || false;
  const canPublishSubflow = session?.capabilities.includes('publishSubflow') || false;
  const canComment = session?.capabilities.includes('comment') || false;
  const canRun = session?.capabilities.includes('runWorkflow') || false;
  const canApprove = session?.capabilities.includes('approve') || false;
  const canUploadAsset = session?.capabilities.includes('uploadAsset') || false;
  const queueStats = useMemo(() => collaborationQueueStats(offlineQueue), [offlineQueue]);
  const renderedTextScope = collaborationTextBindingScopeKey(session);
  const renderedTextRecoveryScope = collaborationTextRecoveryScopeKey(session);
  const visibleTextViews = textScopeRef.current === renderedTextScope ? textViews : {};
  const visibleTextConflicts = textRecoveryScopeRef.current === renderedTextRecoveryScope
    ? textConflicts
    : [];

  const captureMutationFence = useCallback((): CollaborationMutationFence => {
    const currentSession = sessionRef.current;
    const recoveryGeneration = normalizeCollaborationRecoveryGeneration(
      authoritativeGenerationRef.current,
    );
    const activeScope = currentSession
      ? collaborationQueueScope(currentSession, recoveryGeneration)
      : null;
    if (!currentSession?.id
      || !recoveryGeneration
      || !sameCollaborationQueueScope(activeScope, queueScopeRef.current)) {
      throw collaborationMutationScopeChangedError();
    }
    return Object.freeze({
      projectId: currentSession.projectId,
      canvasId: currentSession.canvasId,
      memberId: currentSession.memberId,
      sessionId: currentSession.id,
      authorizationEpoch: currentSession.authorizationEpoch,
      recoveryGeneration,
      scopeGeneration: queueScopeGenerationRef.current,
    });
  }, []);

  const assertMutationFenceCurrent = useCallback((fence: CollaborationMutationFence) => {
    const currentSession = sessionRef.current;
    const currentScope = currentSession
      ? collaborationQueueScope(currentSession, authoritativeGenerationRef.current)
      : null;
    if (!currentSession?.id
      || fence.scopeGeneration !== queueScopeGenerationRef.current
      || fence.projectId !== currentSession.projectId
      || fence.canvasId !== currentSession.canvasId
      || fence.memberId !== currentSession.memberId
      || fence.sessionId !== currentSession.id
      || fence.authorizationEpoch !== currentSession.authorizationEpoch
      || fence.recoveryGeneration !== authoritativeGenerationRef.current
      || !sameCollaborationQueueScope(currentScope, queueScopeRef.current)) {
      throw collaborationMutationScopeChangedError();
    }
  }, []);

  const collaborationMutationRequest = useCallback(async <T,>(
    fence: CollaborationMutationFence,
    url: string,
    init: RequestInit,
    options: Pick<CollaborationRequestOptions, 'timeoutMs' | 'onResponse'> = {},
  ): Promise<T> => collabRequest<T>(url, init, {
    ...options,
    recoveryGeneration: fence.recoveryGeneration,
    assertCurrent: () => assertMutationFenceCurrent(fence),
  }), [assertMutationFenceCurrent]);

  const scopedCollaborationReviewRequest = useCallback(async <T,>(
    url: string,
    init: RequestInit = {},
    options: Pick<CollaborationRequestOptions, 'timeoutMs' | 'onResponse'> = {},
  ): Promise<CollaborationReviewApiEnvelope<T>> => {
    const fence = captureMutationFence();
    return collabEnvelopeRequest<T>(url, init, {
      ...options,
      recoveryGeneration: fence.recoveryGeneration,
      assertCurrent: () => assertMutationFenceCurrent(fence),
    });
  }, [assertMutationFenceCurrent, captureMutationFence]);

  const addScopedTextConflict = useCallback((
    item: CollaborationTextConflictItem,
    scope = textRecoveryScopeRef.current,
  ) => {
    const next = textConflictVaultRef.current.add(scope, item);
    if (textConflictVaultRef.current.isActive(scope)) setTextConflicts(next);
  }, []);

  const ensureTextRegistry = useCallback(() => {
    if (!textRegistryRef.current) {
      textRegistryRef.current = new CollaborationWorkspaceTextRegistry({
        flushDelayMs: 150,
        submit: async (envelope) => {
          const mutationFence = captureMutationFence();
          const assertCurrentScope = () => {
            assertMutationFenceCurrent(mutationFence);
            const activeSession = sessionRef.current;
            if (connectionStateRef.current.phase !== 'online'
              || !activeSession
              || envelope.projectId !== activeSession.projectId
              || envelope.canvasId !== activeSession.canvasId) {
              throw textProtocolError(
                'collaboration_text_offline_forbidden',
                '协同文本只允许在当前在线授权作用域内提交',
              );
            }
            const requiredCapability: WorkspaceCapability = envelope.targetType === 'review'
              ? 'comment'
              : 'editGraph';
            if (!activeSession.capabilities.includes(requiredCapability)) {
              throw Object.assign(textProtocolError(
                'collaboration_text_permission_denied',
                '当前会话已失去该协同文本字段的修改权限',
              ), { status: 403 });
            }
          };
          return submitCollaborationTextUpdate(envelope, assertCurrentScope, {
            recoveryGeneration: mutationFence.recoveryGeneration,
          });
        },
        onView: (key, view) => setTextViews((current) => {
          if (view) return { ...current, [key]: view };
          if (!(key in current)) return current;
          const next = { ...current };
          delete next[key];
          return next;
        }),
        onConflict: (item) => addScopedTextConflict(item),
        onAccepted: (result, envelope) => textAcceptedRef.current(result, envelope),
      });
    }
    return textRegistryRef.current;
  }, [addScopedTextConflict, assertMutationFenceCurrent, captureMutationFence]);
  ensureTextRegistry();

  const updateVisibleDocument = useCallback((
    next: VersionedCanvasData,
    queue = offlineQueueRef.current,
  ) => {
    const activeDrag = localDragRef.current && !localDragRef.current.finalCommitted
      ? [localDragRef.current]
      : [];
    const visibleNodes = displayNodesWithQueuedMoves(
      next,
      queue,
      Object.values(presenceRef.current),
      activeDrag,
    );
    setNodes((current) => {
      const selected = new Map(current.map((node) => [String(node.id), node.selected === true]));
      return visibleNodes.map((node) => selected.has(String(node.id))
        ? { ...node, selected: selected.get(String(node.id)) }
        : node);
    });
    setEdges((current) => {
      const selected = new Map(current.map((edge) => [String(edge.id), edge.selected === true]));
      return (next.edges as Edge[]).map((edge) => selected.has(String(edge.id))
        ? { ...edge, selected: selected.get(String(edge.id)) }
        : edge);
    });
  }, []);

  useEffect(() => {
    const authoritative = authoritativeDocumentRef.current;
    if (authoritative) updateVisibleDocument(authoritative);
  }, [presence, updateVisibleDocument]);

  const updateConnectionState = useCallback((
    phase: CollaborationConnectionPhase,
    message: string,
    attempt = connectionStateRef.current.attempt,
  ) => {
    const next = { phase, message, attempt };
    connectionStateRef.current = next;
    textRegistryRef.current?.setOnline(phase === 'online');
    setConnectionState(next);
  }, [ensureTextRegistry]);

  const commitOfflineQueue = useCallback((
    next: CollaborationQueueItem[],
    expectedScopeGeneration = queueScopeGenerationRef.current,
  ) => {
    if (expectedScopeGeneration !== queueScopeGenerationRef.current) return false;
    if (!validCollaborationQueue(next)) {
      setStatus('协作队列状态无效，已拒绝覆盖当前未提交操作。');
      return false;
    }
    const scope = queueScopeRef.current;
    const storageKey = queueStorageKeyRef.current;
    const storage = availableSessionStorage();
    if (!scope || !storageKey || !storage
      || !saveCollaborationQueue(storage, storageKey, scope, next)) {
      failedQueueTransitionRef.current = {
        scopeGeneration: expectedScopeGeneration,
        queue: next,
      };
      setSaveState({ phase: 'blocked', message: '浏览器无法持久保存未提交队列，本次状态变更已拒绝。' });
      setStatus('sessionStorage 不可用或已满；未覆盖现有协作队列。');
      return false;
    }
    failedQueueTransitionRef.current = null;
    offlineQueueRef.current = next;
    setOfflineQueue(next);
    const authoritative = authoritativeDocumentRef.current;
    if (authoritative) updateVisibleDocument(authoritative, next);
    return true;
  }, [updateVisibleDocument]);

  const activateQueueScope = useCallback((
    nextSession: Session,
    recoveryGeneration: string,
    reason: string,
  ) => {
    const nextScope = collaborationQueueScope(nextSession, recoveryGeneration);
    if (!nextScope) {
      throw new Error('协作会话缺少稳定 sessionId/recovery generation，无法安全恢复未提交操作。');
    }
    const previousScope = queueScopeRef.current;
    if (sameCollaborationQueueScope(previousScope, nextScope)) {
      authoritativeGenerationRef.current = nextScope.recoveryGeneration;
      return { queue: offlineQueueRef.current, rejected: 0, changed: false };
    }
    const recoveryGenerationChanged = Boolean(
      previousScope
      && previousScope.recoveryGeneration !== nextScope.recoveryGeneration,
    );
    const storage = availableSessionStorage();
    const previousKey = queueStorageKeyRef.current;
    if (previousScope && previousKey && offlineQueueRef.current.length > 0) {
      const frozen = freezeCollaborationQueue(offlineQueueRef.current, reason);
      if (!storage || !saveCollaborationQueue(storage, previousKey, previousScope, frozen)) {
        throw new Error('无法持久冻结旧协作队列，已停止作用域切换以避免未提交操作丢失。');
      }
    }
    queueScopeGenerationRef.current += 1;
    setQueueScopeVersion((current) => current + 1);
    failedQueueTransitionRef.current = null;
    syncHighWaterRef.current = 0;
    authoritativeGenerationRef.current = nextScope.recoveryGeneration;
    syncTaskRef.current?.controller.abort();
    syncTaskRef.current = null;
    if (recoveryGenerationChanged) {
      collaborationRunSyncTaskRef.current = null;
      collaborationRunInitializationRef.current = null;
      collaborationRunDetailGenerationRef.current.clear();
      collaborationRunEventCursorRef.current = 0;
      setSharedRunCursor(0);
      setSharedRuns({});
      setOwnRunIntents({});
      setSelectedSharedRunId('');
      setSubflows([]);
      setReviews([]);
      textMaterializedRevisionRef.current.clear();
      reviewTextLoadFenceRef.current?.cancel();
      setReviewRefreshToken((current) => current + 1);
    }
    const storageKey = collaborationQueueStorageKey(nextScope);
    const restored = loadCollaborationQueue(storage, storageKey, nextScope);
    queueRestoreRejectedRef.current = restored.rejected;
    queueScopeRef.current = nextScope;
    queueStorageKeyRef.current = storageKey;
    offlineQueueRef.current = restored.queue;
    setOfflineQueue(restored.queue);
    setSaveState(saveViewForQueue(restored.queue));
    const authoritative = authoritativeDocumentRef.current;
    if (authoritative) updateVisibleDocument(authoritative, restored.queue);
    seqRef.current = Math.max(
      seqRef.current,
      ...restored.queue.map((item) => item.operation.clientSeq + 1),
    );
    return { ...restored, changed: true };
  }, [updateVisibleDocument]);

  const acceptAuthoritativeDocument = useCallback((
    next: VersionedCanvasData,
    options: { allowRevisionRegression?: boolean } = {},
  ) => {
    const activeSession = sessionRef.current;
    if (activeSession
      && (next.projectId !== activeSession.projectId || next.canvasId !== activeSession.canvasId)) return false;
    const current = authoritativeDocumentRef.current;
    if (current
      && current.canvasId === next.canvasId
      && options.allowRevisionRegression !== true
      && Number(next.revision) < Number(current.revision)) return false;
    if (current?.canvasId === next.canvasId) {
      const nextNodeUids = new Set(next.nodes.map((node) => String(node?.entityUid || '')).filter(Boolean));
      for (const node of current.nodes) {
        const entityUid = String(node?.entityUid || '');
        if (entityUid && !nextNodeUids.has(entityUid)) {
          textRegistryRef.current?.invalidateTarget('node', entityUid, {
            code: 'collaboration_text_target_deleted',
          });
        }
      }
    }
    authoritativeDocumentRef.current = next;
    setDocument(next);
    updateVisibleDocument(next);
    textRegistryRef.current?.advanceRevision(next.revision);
    if (connectionStateRef.current.phase === 'online') {
      updateConnectionState(
        'online',
        `协作在线 · revision ${next.revision}`,
        connectionStateRef.current.attempt,
      );
    }
    return true;
  }, [updateConnectionState, updateVisibleDocument]);

  const acceptTextMaterialization = useCallback((
    descriptor: Pick<CollaborationWorkspaceTextDescriptor, 'targetType' | 'targetEntityUid' | 'field'>,
    text: string,
    revision: number,
  ) => {
    const activeSession = sessionRef.current;
    const current = authoritativeDocumentRef.current;
    if (!activeSession || !current
      || current.projectId !== activeSession.projectId
      || current.canvasId !== activeSession.canvasId
      || !Number.isSafeInteger(revision)
      || revision < 1) return false;
    const key = collaborationWorkspaceTextKey(descriptor);
    const materializedRevision = textMaterializedRevisionRef.current.get(key) || 0;
    if (revision < materializedRevision) return false;
    textMaterializedRevisionRef.current.set(key, revision);
    if (descriptor.targetType === 'review') {
      setReviews((currentReviews) => currentReviews.map((thread) => ({
        ...thread,
        comments: thread.comments?.map((item) => item.entityUid === descriptor.targetEntityUid
          ? { ...item, body: text }
          : item),
      })));
    }
    let changed = false;
    const nextNodes = descriptor.targetType === 'node'
      ? current.nodes.map((node) => {
        if (String(node?.entityUid || '') !== descriptor.targetEntityUid) return node;
        changed = true;
        return {
          ...node,
          data: { ...(node.data || {}), [descriptor.field]: text },
        };
      })
      : current.nodes;
    const next = {
      ...current,
      nodes: nextNodes,
      revision: Math.max(Number(current.revision), revision),
    };
    if (changed || next.revision !== current.revision) acceptAuthoritativeDocument(next);
    return true;
  }, [acceptAuthoritativeDocument]);
  textAcceptedRef.current = (result) => {
    const current = authoritativeDocumentRef.current;
    if (!current
      || current.projectId !== result.projectId
      || current.canvasId !== result.canvasId) return;
    if (result.revision < current.revision) return;
    if (result.revision > current.revision + 1) {
      void textAuthorityRecoveryRef.current(result.revision).catch((error) => {
        setStatus(error instanceof Error ? error.message : String(error));
      });
      return;
    }
    acceptTextMaterialization(result, result.text, result.revision);
  };

  useEffect(() => {
    ensureTextRegistry();
    return () => {
      textRegistryRef.current?.dispose();
      textRegistryRef.current = null;
      textScopeRef.current = '';
      textMaterializedRevisionRef.current.clear();
      textDismissedRecoveryIdsRef.current.clear();
      reviewTextLoadFenceRef.current?.cancel();
    };
  }, [ensureTextRegistry]);

  useEffect(() => {
    const registry = ensureTextRegistry();
    const scope = collaborationTextBindingScopeKey(session);
    const recoveryScope = collaborationTextRecoveryScopeKey(session);
    if (textScopeRef.current !== scope) {
      const previousRecoveryScope = textRecoveryScopeRef.current;
      registry.clear({
        code: previousRecoveryScope && previousRecoveryScope === recoveryScope
          ? 'collaboration_text_permission_denied'
          : 'collaboration_text_scope_mismatch',
        status: previousRecoveryScope && previousRecoveryScope === recoveryScope ? 403 : 409,
      });
      textScopeRef.current = scope;
      textRecoveryScopeRef.current = recoveryScope;
      setTextConflicts(textConflictVaultRef.current.activate(recoveryScope));
      textMaterializedRevisionRef.current.clear();
      let dismissedRecoveryIds = recoveryScope
        ? textDismissedRecoveryIdsByScopeRef.current.get(recoveryScope)
        : undefined;
      if (recoveryScope && !dismissedRecoveryIds) {
        dismissedRecoveryIds = new Set<string>();
        textDismissedRecoveryIdsByScopeRef.current.set(recoveryScope, dismissedRecoveryIds);
      }
      textDismissedRecoveryIdsRef.current = dismissedRecoveryIds || new Set<string>();
      setEditingReviewTextKey('');
    }
    const online = Boolean(scope && connectionState.phase === 'online');
    registry.setOnline(online);
    if (!online) {
      setEditingReviewTextKey('');
    }
  }, [
    connectionState.phase,
    ensureTextRegistry,
    session?.id,
    session?.projectId,
    session?.canvasId,
    session?.memberId,
    session?.authorizationEpoch,
    session?.capabilities,
  ]);

  const loadSharedRunDetail = useCallback(async (
    runId: string,
    options: { scopeKey?: string; showLoading?: boolean } = {},
  ) => {
    const normalizedRunId = boundedCollaborationRunText(runId, 240);
    const activeSession = sessionRef.current;
    if (!normalizedRunId || !activeSession) return null;
    const scopeKey = options.scopeKey || collaborationRunScopeKey(
      activeSession,
      authoritativeGenerationRef.current,
    );
    if (!scopeKey || collaborationRunScopeKey(
      activeSession,
      authoritativeGenerationRef.current,
    ) !== scopeKey) return null;
    const requestGeneration = (collaborationRunDetailGenerationRef.current.get(normalizedRunId) || 0) + 1;
    collaborationRunDetailGenerationRef.current.set(normalizedRunId, requestGeneration);
    if (options.showLoading) setSharedRunDetailLoadingId(normalizedRunId);
    try {
      const raw = await collabRequest<unknown>(
        `/api/collab/runs/${encodeURIComponent(normalizedRunId)}`,
      );
      const currentSession = sessionRef.current;
      if (!currentSession
        || collaborationRunScopeKey(currentSession, authoritativeGenerationRef.current) !== scopeKey
        || collaborationRunDetailGenerationRef.current.get(normalizedRunId) !== requestGeneration) return null;
      const detail = normalizeCollaborationRun(raw, currentSession.canvasId);
      if (!detail || detail.id !== normalizedRunId) {
        throw new Error('主机返回的运行详情未通过当前画布安全校验。');
      }
      setSharedRuns((current) => withMergedCollaborationRun(current, detail));
      setSharedRunError('');
      return detail;
    } catch (error) {
      const currentSession = sessionRef.current;
      if (currentSession
        && collaborationRunScopeKey(currentSession, authoritativeGenerationRef.current) === scopeKey) {
        setSharedRunError(error instanceof Error ? error.message : String(error));
      }
      throw error;
    } finally {
      if (options.showLoading) {
        setSharedRunDetailLoadingId((current) => current === normalizedRunId ? '' : current);
      }
    }
  }, []);

  const syncCollaborationRuns = useCallback((activeSession: Session) => {
    const scopeKey = collaborationRunScopeKey(activeSession, authoritativeGenerationRef.current);
    if (!scopeKey) return Promise.resolve();
    const activeTask = collaborationRunSyncTaskRef.current;
    if (activeTask?.scopeKey === scopeKey) return activeTask.promise;
    let promise!: Promise<void>;
    const run = async () => {
      let cursor = collaborationRunEventCursorRef.current;
      let hasMore = true;
      let rounds = 0;
      const affectedRunIds = new Set<string>();
      while (hasMore && rounds < 50) {
        const currentSession = sessionRef.current;
        if (!currentSession
          || collaborationRunScopeKey(currentSession, authoritativeGenerationRef.current) !== scopeKey) return;
        const response = await collabEnvelopeRequest<unknown[]>(
          `/api/collab/runs/sync?afterEventId=${cursor}&limit=1000`,
        );
        const responseSession = sessionRef.current;
        if (!responseSession
          || collaborationRunScopeKey(responseSession, authoritativeGenerationRef.current) !== scopeKey) return;
        const rawEvents = Array.isArray(response.data) ? response.data : [];
        const events = rawEvents
          .map(normalizeCollaborationRunEvent)
          .filter((event): event is CollaborationRunEvent => Boolean(event));
        if (events.length !== rawEvents.length) {
          throw new Error('主机运行增量包含未通过安全校验的事件。');
        }
        const meta = isPlainRecord(response.meta) ? response.meta : {};
        const syncMeta: CollaborationRunSyncMeta = {
          afterEventId: Number(meta.afterEventId),
          nextCursor: Number(meta.nextCursor),
          limit: Number(meta.limit),
          hasMore: meta.hasMore === true,
        };
        const { afterEventId, nextCursor, limit } = syncMeta;
        hasMore = syncMeta.hasMore;
        if (!Number.isSafeInteger(afterEventId) || afterEventId !== cursor
          || !Number.isSafeInteger(nextCursor) || nextCursor < cursor
          || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000
          || rawEvents.length > limit) {
          throw new Error('主机运行增量游标未通过一致性校验。');
        }
        if (events.some((event, index) => index > 0 && event.id <= events[index - 1].id)) {
          throw new Error('主机运行事件顺序无效。');
        }
        const expectedNextCursor = events.length ? events[events.length - 1].id : cursor;
        if (nextCursor !== expectedNextCursor) {
          throw new Error('主机运行增量游标与事件尾部不一致。');
        }
        const unseen = events.filter((event) => event.id > cursor);
        if (hasMore && nextCursor === cursor) {
          throw new Error('主机运行增量没有推进游标。');
        }
        for (const event of unseen) affectedRunIds.add(event.runId);
        if (unseen.length) {
          setSharedRuns((current) => boundedCollaborationRuns(unseen.reduce(
            (next, event) => mergeCollaborationRunEvent(next, event, activeSession.canvasId), current,
          )));
        }
        cursor = nextCursor;
        collaborationRunEventCursorRef.current = cursor;
        setSharedRunCursor(cursor);
        rounds += 1;
      }
      if (hasMore) throw new Error('运行增量超过单次安全恢复上限，请重新连接后继续同步。');
      const latestAffected = [...affectedRunIds].slice(-50);
      await Promise.all(latestAffected.map((runId) => loadSharedRunDetail(runId, { scopeKey })));
      const currentSession = sessionRef.current;
      if (currentSession
        && collaborationRunScopeKey(currentSession, authoritativeGenerationRef.current) === scopeKey) {
        setSharedRunError('');
      }
    };
    promise = run().finally(() => {
      if (collaborationRunSyncTaskRef.current?.promise === promise) collaborationRunSyncTaskRef.current = null;
    });
    collaborationRunSyncTaskRef.current = { scopeKey, promise };
    return promise;
  }, [loadSharedRunDetail]);

  const initializeCollaborationRuns = useCallback((activeSession: Session) => {
    const scopeKey = collaborationRunScopeKey(activeSession, authoritativeGenerationRef.current);
    if (!scopeKey) return Promise.resolve();
    const activeTask = collaborationRunInitializationRef.current;
    if (activeTask?.scopeKey === scopeKey) return activeTask.promise;
    collaborationRunEventCursorRef.current = 0;
    collaborationRunDetailGenerationRef.current.clear();
    setSharedRunCursor(0);
    setSharedRuns({});
    setOwnRunIntents({});
    setSelectedSharedRunId('');
    setSharedRunError('');
    let promise!: Promise<void>;
    const run = async () => {
      const response = await collabEnvelopeRequest<unknown[]>('/api/collab/runs?limit=50');
      const currentSession = sessionRef.current;
      if (!currentSession
        || collaborationRunScopeKey(currentSession, authoritativeGenerationRef.current) !== scopeKey) return;
      const rawRuns = Array.isArray(response.data) ? response.data : [];
      const normalized = rawRuns
        .map((item) => normalizeCollaborationRun(item, activeSession.canvasId))
        .filter((item): item is CollaborationRun => Boolean(item));
      if (normalized.length !== rawRuns.length) {
        throw new Error('主机运行快照包含未通过当前画布安全校验的记录。');
      }
      setSharedRuns(Object.fromEntries(normalized.map((item) => [item.id, item])));
      await syncCollaborationRuns(activeSession);
    };
    promise = run().catch((error) => {
      if (collaborationRunInitializationRef.current?.promise === promise) {
        collaborationRunInitializationRef.current = null;
      }
      const currentSession = sessionRef.current;
      if (currentSession
        && collaborationRunScopeKey(currentSession, authoritativeGenerationRef.current) === scopeKey) {
        setSharedRunError(error instanceof Error ? error.message : String(error));
      }
      throw error;
    });
    collaborationRunInitializationRef.current = { scopeKey, promise };
    return promise;
  }, [syncCollaborationRuns]);

  const loadCanvas = useCallback(async (
    scopedCanvasId: string,
    options: {
      resetTransient?: boolean;
      showBusy?: boolean;
      announce?: boolean;
      scopeGeneration?: number;
      signal?: AbortSignal;
    } = {},
  ) => {
    if (!scopedCanvasId) return;
    if (options.showBusy !== false) setBusy(true);
    try {
      const next = await collabRequest<VersionedCanvasData>(
        `/api/collab/canvases/${encodeURIComponent(scopedCanvasId)}`,
        { signal: options.signal },
      );
      if (options.scopeGeneration != null
        && options.scopeGeneration !== queueScopeGenerationRef.current) return;
      if (next.canvasId !== scopedCanvasId) {
        throw new Error('协作网关返回的画布与当前会话授权不一致。');
      }
      if (!acceptAuthoritativeDocument(next)) return;
      if (options.resetTransient !== false) {
        setSelectedNodeId('');
        const nextReviews = await collabRequest<ReviewThread[]>(
          `/api/collab/reviews?canvasId=${encodeURIComponent(scopedCanvasId)}`,
          { signal: options.signal },
        );
        if (options.scopeGeneration != null
          && options.scopeGeneration !== queueScopeGenerationRef.current) return;
        setReviews(nextReviews);
      }
      if (options.announce !== false) setStatus(`已同步 revision ${next.revision}`);
      return next;
    } catch (error) {
      if ((error as { name?: string })?.name !== 'AbortError') {
        setStatus(error instanceof Error ? error.message : String(error));
      }
      throw error;
    } finally {
      if (options.showBusy !== false
        && (options.scopeGeneration == null
          || options.scopeGeneration === queueScopeGenerationRef.current)) setBusy(false);
    }
  }, [acceptAuthoritativeDocument]);

  const loadSubflows = useCallback(async (shouldApply: () => boolean = () => true) => {
    const next = await collabRequest<SubflowDefinition[]>('/api/collab/subflows');
    if (shouldApply()) setSubflows(next);
    return next;
  }, []);

  const bootstrap = useCallback(async () => {
    setBusy(true);
    try {
      const params = new URLSearchParams(location.search);
      const invite = params.get('invite') || '';
      const requestedCanvasId = requestedCanvasIdFromLocation();
      let nextSession: Session;
      if (invite) {
        localStorage.setItem('t8-collab-display-name', displayName.trim() || '访客');
        const redeemed = await collabRequest<Session>('/api/collab/invites/redeem', {
          method: 'POST',
          body: JSON.stringify({
            code: invite,
            displayName: displayName.trim() || '访客',
            ...(requestedCanvasId ? { canvasId: requestedCanvasId } : {}),
          }),
        }, { recoveryGeneration: null });
        removeInviteFromAddressBar();
        nextSession = await collabRequest<Session>('/api/collab/session');
        if (redeemed.canvasId !== nextSession.canvasId || redeemed.memberId !== nextSession.memberId) {
          throw new Error('邀请兑换后的协作会话作用域不一致，请重新打开邀请链接。');
        }
      } else {
        nextSession = await collabRequest<Session>('/api/collab/session');
      }
      if (!String(nextSession.canvasId || '').trim()) {
        throw new Error('协作会话缺少画布授权，请联系主机重新生成邀请。');
      }
      if (requestedCanvasId && requestedCanvasId !== nextSession.canvasId) {
        throw new Error('邀请链接指定的画布与当前协作会话不一致，请重新打开正确的邀请链接。');
      }
      const nextCanvases = await collabRequest<CanvasSummary[]>('/api/collab/canvases');
      if (nextCanvases.length !== 1 || nextCanvases[0]?.id !== nextSession.canvasId) {
        throw new Error('协作网关返回了超出当前会话授权范围的画布，请联系主机重新生成邀请。');
      }
      setSession(nextSession);
      sessionRef.current = nextSession;
      setCanvases([nextCanvases[0]]);
      await loadCanvas(nextSession.canvasId, {
        resetTransient: true,
        showBusy: false,
        scopeGeneration: queueScopeGenerationRef.current,
      });
      const recovered = await canvasRecoveryRef.current(
        authoritativeDocumentRef.current?.revision || 0,
      );
      const activeScope = collaborationQueueScope(
        nextSession,
        authoritativeGenerationRef.current,
      );
      if (!recovered || !sameCollaborationQueueScope(activeScope, queueScopeRef.current)) {
        throw new Error('未能用权威 recovery generation 完成首次画布同步，离线队列保持冻结。');
      }
      await initializeCollaborationRuns(nextSession);
      const restoredQueue = offlineQueueRef.current;
      if (restoredQueue.length) {
        const view = saveViewForQueue(restoredQueue);
        setSaveState({ ...view, message: `已恢复 ${restoredQueue.length} 条本页未提交移动操作；${view.message}` });
      }
      if (queueRestoreRejectedRef.current > 0) {
        setStatus(`有 ${queueRestoreRejectedRef.current} 条损坏或越界的本地队列记录未被载入`);
      }
      updateConnectionState('connecting', '画布已载入，正在连接协作网关…', 0);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus(message);
      updateConnectionState('blocked', message, 0);
    }
    finally { setBusy(false); }
  }, [displayName, initializeCollaborationRuns, loadCanvas, updateConnectionState]);

  const clearVisibleWorkspaceAfterLogout = useCallback(() => {
    socketGenerationRef.current += 1;
    queueScopeGenerationRef.current += 1;
    setQueueScopeVersion((current) => current + 1);
    syncTaskRef.current?.controller.abort();
    syncTaskRef.current = null;
    collaborationRunSyncTaskRef.current = null;
    collaborationRunInitializationRef.current = null;
    collaborationRunDetailGenerationRef.current.clear();
    const socket = webSocketRef.current;
    webSocketRef.current = null;
    retryConnectionRef.current = null;
    if (socket && (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN)) {
      try { socket.close(1000, 'participant signed out'); } catch { /* already closing */ }
    }
    textRegistryRef.current?.dispose();
    textRegistryRef.current = null;
    textScopeRef.current = '';
    textRecoveryScopeRef.current = '';
    textMaterializedRevisionRef.current.clear();
    reviewTextLoadFenceRef.current?.cancel();
    textConflictVaultRef.current = new CollaborationTextConflictScopeVault();
    authoritativeDocumentRef.current = null;
    authoritativeGenerationRef.current = null;
    sessionRef.current = null;
    offlineQueueRef.current = [];
    queueScopeRef.current = null;
    queueStorageKeyRef.current = '';
    failedQueueTransitionRef.current = null;
    presenceRef.current = {};
    localPresenceRef.current = {};
    setSession(null);
    setCanvases([]);
    setDocument(null);
    setNodes([]);
    setEdges([]);
    setSelectedNodeId('');
    setReviews([]);
    setTextViews({});
    setTextConflicts([]);
    setEditingReviewTextKey('');
    setOfflineQueue([]);
    setSaveState({ phase: 'saved', message: '当前会话已退出' });
    setPresence({});
    setSharedRuns({});
    setOwnRunIntents({});
    setSelectedSharedRunId('');
    setSharedRunCursor(0);
    setSharedRunDetailLoadingId('');
    setSharedRunError('');
    setSubflows([]);
    setSubflowDraft(null);
    setBusy(false);
    setStatus('已退出当前协作会话。若要继续，请打开新的邀请链接。');
    updateConnectionState('revoked', '当前参与者已退出，旧会话凭据已撤销。', 0);
  }, [updateConnectionState]);

  const rotateParticipantSession = useCallback(async () => {
    const current = sessionRef.current;
    if (!current || participantSessionAction) return;
    if (offlineQueueRef.current.length > 0
      || structureBusy
      || saveState.phase === 'saving') {
      setParticipantSessionConfirmation(null);
      setStatus('请先恢复在线并等待未提交操作保存完成，再轮换会话凭据。');
      return;
    }
    if (participantSessionConfirmation !== 'rotate') {
      setParticipantSessionConfirmation('rotate');
      setStatus('再次点击“确认轮换”将撤销旧凭据，并用新会话重新连接当前画布。');
      return;
    }
    setParticipantSessionConfirmation(null);
    setParticipantSessionAction('rotate');
    try {
      const mutationFence = captureMutationFence();
      const rotated = await rotateCurrentCollaborationSession(mutationFence.recoveryGeneration);
      assertMutationFenceCurrent(mutationFence);
      if (!isSafeRotatedParticipantSession(rotated, current)) {
        throw new Error('轮换后的会话身份或画布作用域未通过校验。');
      }
      activateQueueScope(
        rotated,
        mutationFence.recoveryGeneration,
        '会话凭据轮换后，旧会话作用域操作已冻结且不会跨作用域重放。',
      );
      sessionRef.current = rotated;
      setSession(rotated);
      setStatus('会话凭据已安全轮换，旧凭据已撤销。');
      updateConnectionState('reconnecting', '会话已轮换，正在使用新凭据重新连接。', 0);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus(`轮换会话失败：${message}`);
    } finally {
      setParticipantSessionAction(null);
    }
  }, [
    activateQueueScope,
    assertMutationFenceCurrent,
    captureMutationFence,
    participantSessionAction,
    participantSessionConfirmation,
    saveState.phase,
    structureBusy,
    updateConnectionState,
  ]);

  const logoutParticipantSession = useCallback(async () => {
    if (!sessionRef.current || participantSessionAction) return;
    if (participantSessionConfirmation !== 'logout') {
      setParticipantSessionConfirmation('logout');
      const pending = offlineQueueRef.current.length;
      setStatus(pending > 0
        ? `当前有 ${pending} 条未提交操作；退出后不会自动重放。再次点击“确认退出”以撤销当前会话。`
        : '再次点击“确认退出”将撤销当前会话，并立即关闭它的在线连接。');
      return;
    }
    setParticipantSessionConfirmation(null);
    setParticipantSessionAction('logout');
    try {
      const mutationFence = captureMutationFence();
      await logoutCurrentCollaborationSession();
      assertMutationFenceCurrent(mutationFence);
      clearVisibleWorkspaceAfterLogout();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus(`无法确认退出结果：${message}。请检查连接后重试。`);
    } finally {
      setParticipantSessionAction(null);
    }
  }, [
    assertMutationFenceCurrent,
    captureMutationFence,
    clearVisibleWorkspaceAfterLogout,
    participantSessionAction,
    participantSessionConfirmation,
  ]);

  useEffect(() => {
    if (bootstrapStartedRef.current) return;
    bootstrapStartedRef.current = true;
    void bootstrap();
  }, [bootstrap]); // 邀请只兑换一次，避免 StrictMode 或昵称变化重复消耗次数

  const recoverCanvas = useCallback((targetRevision = 0) => {
    const numericTargetRevision = Number(targetRevision);
    const normalizedTargetRevision = Number.isSafeInteger(numericTargetRevision) && numericTargetRevision >= 0
      ? numericTargetRevision
      : 0;
    const scopeGeneration = queueScopeGenerationRef.current;
    syncHighWaterRef.current = Math.max(syncHighWaterRef.current, normalizedTargetRevision);
    const activeTask = syncTaskRef.current;
    if (activeTask?.scopeGeneration === scopeGeneration) return activeTask.promise;
    activeTask?.controller.abort();
    const controller = new AbortController();
    const run = async () => {
      let recovered = false;
      let rounds = 0;
      do {
        if (scopeGeneration !== queueScopeGenerationRef.current) return false;
        const currentSession = sessionRef.current;
        const base = authoritativeDocumentRef.current;
        if (!currentSession || !base || base.canvasId !== currentSession.canvasId) return false;
        const activeScope = collaborationQueueScope(
          currentSession,
          authoritativeGenerationRef.current,
        );
        if (queueScopeRef.current
          && !sameCollaborationQueueScope(activeScope, queueScopeRef.current)) return false;
        const desiredRevision = Math.max(syncHighWaterRef.current, base.revision);
        syncHighWaterRef.current = 0;
        const requestedGeneration = authoritativeGenerationRef.current;
        const generationQuery = requestedGeneration
          ? `&generation=${encodeURIComponent(requestedGeneration)}`
          : '';
        const sync = await collabRequest<CollaborationSyncEnvelope>(
          `/api/collab/canvases/${encodeURIComponent(base.canvasId)}/sync?afterRevision=${encodeURIComponent(String(base.revision))}${generationQuery}`,
          { signal: controller.signal },
        );
        if (scopeGeneration !== queueScopeGenerationRef.current) return false;
        const previousGeneration = requestedGeneration;
        const syncGeneration = normalizeCollaborationRecoveryGeneration(sync.generation);
        if (!syncGeneration) {
          throw new CollaborationSyncFallbackError(
            'recovery_generation_missing',
            '主机同步响应缺少有效 recovery generation，不能激活离线队列',
          );
        }
        const serverReportedGenerationChange = sync.mode === 'snapshot'
          && sync.reason === 'recovery_generation_changed';
        const recoveryGenerationChanged = syncGeneration !== previousGeneration
          && (Boolean(previousGeneration) || serverReportedGenerationChange);
        if (sync.mode === 'operations'
          && recoveryGenerationChanged) {
          throw new CollaborationSyncFallbackError(
            'recovery_generation_mismatch',
            '主机恢复代次已变化，不能应用旧 revision namespace 的增量',
          );
        }
        if (recoveryGenerationChanged
          && (sync.mode !== 'snapshot' || sync.reason !== 'recovery_generation_changed')) {
          throw new CollaborationSyncFallbackError(
            'recovery_generation_snapshot_required',
            '主机恢复代次已变化，必须先返回该代次的权威快照',
          );
        }
        let next: VersionedCanvasData;
        let deltaOperations: CollaborationSyncEnvelopeOperations['operations'] = [];
        let appliedOperationsDelta = false;
        let textBindingsNeedReload = sync.mode === 'snapshot';
        if (sync.mode === 'operations') {
          deltaOperations = sync.operations;
        }
        try {
          next = applyCollaborationSync(base, sync, { maxOperations: maxSyncOperationsRef.current });
          appliedOperationsDelta = sync.mode === 'operations';
        } catch (error) {
          if (!(error instanceof CollaborationSyncFallbackError)) throw error;
          textBindingsNeedReload = true;
          const snapshot = await loadCanvas(base.canvasId, {
            resetTransient: false,
            showBusy: false,
            announce: false,
            scopeGeneration,
            signal: controller.signal,
          });
          if (!snapshot) return false;
          next = snapshot;
          setStatus(`增量无法安全应用，已使用权威快照恢复 revision ${snapshot.revision}`);
        }
        if (scopeGeneration !== queueScopeGenerationRef.current) return false;
        if (textBindingsNeedReload) {
          textRegistryRef.current?.invalidateAuthority({
            code: 'collaboration_text_revision_conflict',
          });
          setTextBindingReload((current) => current + 1);
        }
        const allowRevisionRegression = sync.mode === 'snapshot'
          && (sync.reason === 'client_ahead' || recoveryGenerationChanged);
        if (!acceptAuthoritativeDocument(next, { allowRevisionRegression })) return false;
        const nextQueueScope = collaborationQueueScope(currentSession, syncGeneration);
        if (!sameCollaborationQueueScope(nextQueueScope, queueScopeRef.current)) {
          activateQueueScope(
            currentSession,
            syncGeneration,
            recoveryGenerationChanged
              ? '主机 recovery generation 已变化；旧代次队列已冻结，不能按相同 revision 自动借用新代次。'
              : '已绑定主机 recovery generation；其他代次的本地队列不会自动重放。',
          );
          const activatedScopeGeneration = queueScopeGenerationRef.current;
          const isActivatedSubflowScopeCurrent = () => (
            activatedScopeGeneration === queueScopeGenerationRef.current
            && syncGeneration === normalizeCollaborationRecoveryGeneration(
              authoritativeGenerationRef.current,
            )
            && sessionRef.current?.id === currentSession.id
            && sessionRef.current?.authorizationEpoch === currentSession.authorizationEpoch
          );
          await loadSubflows(isActivatedSubflowScopeCurrent);
          if (!isActivatedSubflowScopeCurrent()) return false;
          await initializeCollaborationRuns(currentSession);
          if (!isActivatedSubflowScopeCurrent()) return false;
          if (recoveryGenerationChanged) {
            setStatus(`主机已从备份恢复，客户端已切换到新的 revision namespace 并载入权威快照 revision ${next.revision}。`);
          }
          return true;
        }
        authoritativeGenerationRef.current = syncGeneration;
        if (recoveryGenerationChanged) {
          setStatus(`主机已从备份恢复，客户端已切换到新的 revision namespace 并载入权威快照 revision ${next.revision}。`);
        } else if (allowRevisionRegression) {
          setStatus(`主机权威画布已回退到 revision ${next.revision}；未提交操作仍按原身份保留。`);
        }
        if (appliedOperationsDelta && deltaOperations.length > 0) {
          const filtered = offlineQueueRef.current.filter((item) => !deltaOperations.some((operation) => (
            collaborationDeltaAcknowledgesQueuedMove(operation, item, currentSession.memberId)
          )));
          if (filtered.length !== offlineQueueRef.current.length) {
            if (!commitOfflineQueue(filtered, scopeGeneration)) return false;
            setSaveState(saveViewForQueue(filtered));
          }
        }
        recovered = true;
        rounds += 1;
        const appliedRevision = authoritativeDocumentRef.current?.revision || next.revision;
        if (!allowRevisionRegression && desiredRevision > appliedRevision) {
          if (appliedRevision <= base.revision || rounds >= 8) {
            throw new Error(`协作同步未能恢复到目标 revision ${desiredRevision}`);
          }
          syncHighWaterRef.current = Math.max(syncHighWaterRef.current, desiredRevision);
        }
      } while (
        syncHighWaterRef.current
        > Number(authoritativeDocumentRef.current?.revision || 0)
      );
      return recovered;
    };
    let promise!: Promise<boolean>;
    promise = run().finally(() => {
      if (syncTaskRef.current?.promise === promise) syncTaskRef.current = null;
    });
    syncTaskRef.current = { scopeGeneration, controller, promise };
    return promise;
  }, [
    acceptAuthoritativeDocument,
    activateQueueScope,
    commitOfflineQueue,
    initializeCollaborationRuns,
    loadCanvas,
    loadSubflows,
  ]);
  canvasRecoveryRef.current = recoverCanvas;
  textAuthorityRecoveryRef.current = recoverCanvas;

  const flushOfflineQueue = useCallback((): Promise<void> => {
    if (flushPromiseRef.current) {
      return flushPromiseRef.current.then(() => {
        if (connectionStateRef.current.phase === 'online' && offlineQueueRef.current.length > 0) {
          return flushOfflineQueue();
        }
      });
    }
    const scopeGeneration = queueScopeGenerationRef.current;
    const run = async () => {
      while (offlineQueueRef.current.length > 0) {
        if (scopeGeneration !== queueScopeGenerationRef.current) return;
        const currentSession = sessionRef.current;
        const authoritative = authoritativeDocumentRef.current;
        if (!currentSession || !authoritative) return;
        const activeScope = collaborationQueueScope(
          currentSession,
          authoritativeGenerationRef.current,
        );
        if (!sameCollaborationQueueScope(activeScope, queueScopeRef.current)) return;
        if (!currentSession.capabilities.includes('editGraph')) {
          const blocked = freezeCollaborationQueue(
            offlineQueueRef.current,
            '当前角色没有画布编辑能力，未提交操作已冻结。',
          );
          if (!commitOfflineQueue(blocked, scopeGeneration)) return;
          setSaveState(saveViewForQueue(blocked));
          return;
        }
        if (connectionStateRef.current.phase !== 'online') return;
        const item = firstCollaborationQueueItemForReplay(offlineQueueRef.current);
        if (!item) {
          setSaveState(saveViewForQueue(offlineQueueRef.current));
          return;
        }
        const mutationFence = captureMutationFence();
        const baseRevision = item.baseRevision ?? authoritative.revision;
        const sendingQueue = updateCollaborationQueueItem(offlineQueueRef.current, item.id, {
          baseRevision,
          status: 'inflight',
          attempts: item.attempts + 1,
          error: undefined,
        });
        if (!commitOfflineQueue(sendingQueue, scopeGeneration)) return;
        setSaveState(saveViewForQueue(sendingQueue));
        try {
          const result = await collaborationMutationRequest<unknown>(
            mutationFence,
            `/api/collab/canvases/${encodeURIComponent(authoritative.canvasId)}/operations`,
            {
              method: 'POST',
              body: JSON.stringify({
                baseRevision,
                operations: [item.operation],
              }),
            },
          );
          if (scopeGeneration !== queueScopeGenerationRef.current) return;
          const confirmed = acceptCollaborationMoveMutationResult(result, {
            operation: item.operation,
            baseRevision,
          }, {
            projectId: currentSession.projectId,
            canvasId: authoritative.canvasId,
            memberId: currentSession.memberId,
          });
          if (!acceptAuthoritativeDocument(confirmed.document)) return;
          const nextQueue = removeCollaborationQueueItem(offlineQueueRef.current, item.id);
          if (!commitOfflineQueue(nextQueue, scopeGeneration)) return;
          setSaveState(saveViewForQueue(nextQueue, confirmed.document.revision));
          if (Number(authoritativeDocumentRef.current?.revision || 0) > Number(confirmed.document.revision)) {
            void recoverCanvas(authoritativeDocumentRef.current?.revision || 0).catch((error) => {
              setStatus(error instanceof Error ? error.message : String(error));
              const socket = webSocketRef.current;
              if (socket?.readyState === WebSocket.OPEN) socket.close(4000, 'post-save sync failed');
            });
          }
        } catch (error: any) {
          if (scopeGeneration !== queueScopeGenerationRef.current) return;
          const live = offlineQueueRef.current.find((entry) => entry.id === item.id);
          if (!live) continue;
          if (error?.status === 409 && [
            'canvas_generation_required',
            'canvas_generation_changed',
          ].includes(String(error?.code || ''))) {
            const rebased = updateCollaborationQueueItem(offlineQueueRef.current, item.id, {
              baseRevision: live.baseRevision,
              status: 'pending',
              ambiguous: false,
              error: '旧 recovery generation 已被主机拒绝；该代次队列会在权威快照切换后冻结。',
            });
            if (!commitOfflineQueue(rebased, scopeGeneration)) return;
            setSaveState({ phase: 'pending', message: '主机恢复代次已变化，先载入权威快照再提交' });
            await recoverCanvas(0);
            if (scopeGeneration !== queueScopeGenerationRef.current) return;
            continue;
          }
          if (error?.status === 409 && error?.code === 'revision_conflict') {
            if (live.rebaseAttempts >= 3) {
              const blocked = updateCollaborationQueueItem(offlineQueueRef.current, item.id, {
                status: 'blocked',
                ambiguous: false,
                error: '画布持续变化，已停止自动重基；操作仍保留在本机。',
              });
              if (!commitOfflineQueue(blocked, scopeGeneration)) return;
              setSaveState(saveViewForQueue(blocked));
              return;
            }
            const rebased = updateCollaborationQueueItem(offlineQueueRef.current, item.id, {
              baseRevision: null,
              status: 'pending',
              ambiguous: false,
              rebaseAttempts: live.rebaseAttempts + 1,
              error: undefined,
            });
            if (!commitOfflineQueue(rebased, scopeGeneration)) return;
            setSaveState({ phase: 'pending', message: '检测到 revision 冲突，先同步再安全重基' });
            await recoverCanvas(Number(error?.currentRevision) || 0);
            if (scopeGeneration !== queueScopeGenerationRef.current) return;
            continue;
          }
          if (isDefinitiveCollaborationOperationRejection(error)) {
            const blocked = updateCollaborationQueueItem(offlineQueueRef.current, item.id, {
              status: 'blocked',
              ambiguous: false,
              error: error instanceof Error ? error.message : String(error),
            });
            if (!commitOfflineQueue(blocked, scopeGeneration)) return;
            setSaveState(saveViewForQueue(blocked));
            return;
          }
          const ambiguous = updateCollaborationQueueItem(offlineQueueRef.current, item.id, {
            status: 'pending',
            ambiguous: true,
            error: '网络中断，提交结果未知；重连后将用原 opId 与 baseRevision 精确重试。',
          });
          if (!commitOfflineQueue(ambiguous, scopeGeneration)) return;
          setSaveState(saveViewForQueue(ambiguous));
          updateConnectionState('offline', '协作 HTTP 连接不可达，正在等待 WebSocket 重连。');
          const socket = webSocketRef.current;
          if (socket?.readyState === WebSocket.OPEN) socket.close(4000, 'collaboration request unavailable');
          return;
        }
      }
    };
    const promise = run().finally(() => {
      if (flushPromiseRef.current === promise) flushPromiseRef.current = null;
    });
    flushPromiseRef.current = promise;
    return promise;
  }, [
    acceptAuthoritativeDocument,
    captureMutationFence,
    collaborationMutationRequest,
    commitOfflineQueue,
    recoverCanvas,
    updateConnectionState,
  ]);

  useEffect(() => {
    if (!session || !socketScopeReady || !authoritativeDocumentRef.current) return;
    const generation = ++socketGenerationRef.current;
    const scopeGeneration = queueScopeGenerationRef.current;
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const webSocketUrl = `${protocol}//${location.host}/ws/collab`;
    let disposed = false;
    let activeSocket: WebSocket | null = null;
    let reconnectTimer: number | null = null;
    let heartbeatTimer: number | null = null;
    let handshakeTimer: number | null = null;
    let reconnectAttempt = 0;
    let joined = false;
    let lastPongAt = Date.now();
    let pendingHeartbeatNonce = '';
    let gatewayNotice: CollaborationGatewayNotice | null = null;
    let protocolSettings = normalizeCollaborationProtocol(null);
    let roleRefreshStarted = false;
    let localConnectionId = '';
    const isCurrent = (socket?: WebSocket | null) => (
      !disposed
      && socketGenerationRef.current === generation
      && queueScopeGenerationRef.current === scopeGeneration
      && sessionRef.current?.id === session.id
      && sessionRef.current?.canvasId === session.canvasId
      && sessionRef.current?.authorizationEpoch === session.authorizationEpoch
      && (!socket || activeSocket === socket)
    );
    const clearReconnectTimer = () => {
      if (reconnectTimer === null) return;
      window.clearTimeout(reconnectTimer);
      reconnectTimer = null;
    };
    const clearHeartbeatTimer = () => {
      if (heartbeatTimer === null) return;
      window.clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    };
    const clearHandshakeTimer = () => {
      if (handshakeTimer === null) return;
      window.clearTimeout(handshakeTimer);
      handshakeTimer = null;
    };
    const armHandshakeTimer = (socket: WebSocket, phase: 'connect' | 'join') => {
      clearHandshakeTimer();
      handshakeTimer = window.setTimeout(() => {
        handshakeTimer = null;
        if (!isCurrent(socket) || joined) return;
        const label = phase === 'connect' ? '建立 WebSocket' : '加入授权画布';
        setStatus(`${label}超过 ${Math.round(COLLABORATION_HANDSHAKE_TIMEOUT_MS / 1000)} 秒，正在重连。`);
        try { socket.close(4000, `${phase} timeout`); } catch { scheduleReconnect(`${label}超时。`); }
      }, COLLABORATION_HANDSHAKE_TIMEOUT_MS);
    };
    const sendPresence = (socket: WebSocket) => {
      if (!isCurrent(socket) || !joined || socket.readyState !== WebSocket.OPEN) return;
      socket.send(JSON.stringify({ type: 'presence.update', presence: localPresenceRef.current }));
    };
    const refreshSessionAfterRoleChange = async (): Promise<void> => {
      if (roleRefreshStarted) return;
      roleRefreshStarted = true;
      try {
        const nextSession = await collabRequest<Session>('/api/collab/session');
        if (!isCurrent()) return;
        if (!nextSession.canvasId
          || nextSession.canvasId !== session.canvasId
          || nextSession.memberId !== session.memberId) {
          throw new Error('成员权限更新后的画布授权不一致，请联系主机重新邀请。');
        }
        const recoveryGeneration = normalizeCollaborationRecoveryGeneration(
          authoritativeGenerationRef.current,
        );
        if (!recoveryGeneration) {
          throw new Error('权限刷新时缺少已确认 recovery generation。');
        }
        const activated = activateQueueScope(
          nextSession,
          recoveryGeneration,
          '成员角色或会话作用域已经变化，旧作用域操作已冻结且不会自动重放。',
        );
        sessionRef.current = nextSession;
        if (!activated.changed
          && !nextSession.capabilities.includes('editGraph')
          && offlineQueueRef.current.length) {
          const blocked = freezeCollaborationQueue(
            offlineQueueRef.current,
            '角色变化后已失去画布编辑能力，操作未自动重放。',
          );
          if (!commitOfflineQueue(blocked, queueScopeGenerationRef.current)) {
            throw new Error('角色变化后的未提交队列无法持久冻结。');
          }
          setSaveState(saveViewForQueue(blocked));
        }
        setSession(nextSession);
        setStatus(`权限已更新为 ${nextSession.role}，协作连接正在刷新。`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setStatus(message);
        const statusCode = Number((error as { status?: unknown })?.status);
        if (statusCode === 401 || statusCode === 403 || /作用域不一致/.test(message)) {
          updateConnectionState('blocked', message);
          return;
        }
        if (!isCurrent()) return;
        clearReconnectTimer();
        const delay = collaborationReconnectDelay(reconnectAttempt);
        reconnectAttempt += 1;
        updateConnectionState(
          'reconnecting',
          `刷新协作权限失败，${Math.max(0.1, delay / 1000).toFixed(1)} 秒后重试。`,
          reconnectAttempt,
        );
        reconnectTimer = window.setTimeout(() => {
          reconnectTimer = null;
          roleRefreshStarted = false;
          void refreshSessionAfterRoleChange();
        }, delay);
      }
    };
    const scheduleReconnect = (message: string, requestedDelay?: number) => {
      if (!isCurrent()) return;
      clearReconnectTimer();
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        updateConnectionState('offline', '浏览器当前离线；未提交操作已保留，恢复网络后继续连接。', reconnectAttempt);
        return;
      }
      const delay = requestedDelay == null
        ? collaborationReconnectDelay(reconnectAttempt)
        : Math.max(0, Number(requestedDelay) || 0);
      reconnectAttempt += 1;
      updateConnectionState(
        'reconnecting',
        `${message} ${delay > 0 ? `${Math.max(0.1, delay / 1000).toFixed(1)} 秒后重试。` : '正在立即重试。'}`,
        reconnectAttempt,
      );
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, delay);
    };
    const startHeartbeat = (socket: WebSocket) => {
      clearHeartbeatTimer();
      lastPongAt = Date.now();
      pendingHeartbeatNonce = '';
      heartbeatTimer = window.setInterval(() => {
        if (!isCurrent(socket) || socket.readyState !== WebSocket.OPEN || !joined) return;
        const now = Date.now();
        if (collaborationHeartbeatExpired(lastPongAt, now, protocolSettings.heartbeatTimeoutMs)) {
          socket.close(4000, 'heartbeat timeout');
          return;
        }
        if (pendingHeartbeatNonce) return;
        pendingHeartbeatNonce = `${generation}:${now}:${Math.random().toString(36).slice(2)}`;
        socket.send(JSON.stringify({
          type: 'ping',
          nonce: pendingHeartbeatNonce,
          canvasId: session.canvasId,
          revision: authoritativeDocumentRef.current?.revision || 0,
        }));
      }, protocolSettings.heartbeatIntervalMs);
    };
    const handleMessage = async (socket: WebSocket, event: MessageEvent) => {
      if (!isCurrent(socket)) return;
      let message: any;
      try { message = JSON.parse(String(event.data)); } catch { return; }
      if (message.type === 'session.ready') {
        const readySession = message.session && typeof message.session === 'object' ? message.session : {};
        if (readySession.id !== session.id
          || readySession.projectId !== session.projectId
          || readySession.canvasId !== session.canvasId
          || readySession.memberId !== session.memberId
          || readySession.authorizationEpoch !== session.authorizationEpoch) {
          updateConnectionState('blocked', 'WebSocket 会话作用域与已验证的 HTTP 会话不一致。');
          socket.close(1008, 'session scope mismatch');
          return;
        }
        localConnectionId = String(message.connectionId || '').trim();
        if (!localConnectionId) {
          updateConnectionState('blocked', 'WebSocket 缺少稳定 connectionId，无法隔离 Presence。');
          socket.close(1008, 'connection id missing');
          return;
        }
        protocolSettings = normalizeCollaborationProtocol(message.protocol);
        if (protocolSettings.version !== COLLABORATION_PROTOCOL_VERSION) {
          updateConnectionState('blocked', `协作协议版本不受支持（需要 v${COLLABORATION_PROTOCOL_VERSION}）。`);
          socket.close(1008, 'unsupported collaboration protocol');
          return;
        }
        maxSyncOperationsRef.current = protocolSettings.maxSyncOperations;
        return;
      }
      if (message.type === 'pong') {
        if (!pendingHeartbeatNonce
          || message.nonce !== pendingHeartbeatNonce
          || message.canvasId !== session.canvasId) return;
        pendingHeartbeatNonce = '';
        lastPongAt = Date.now();
        const heartbeatGenerationChanged = typeof message.generation === 'string'
          && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(message.generation)
          && message.generation.toLowerCase() !== authoritativeGenerationRef.current;
        if (heartbeatGenerationChanged || (typeof message.revision === 'number'
          && Number.isSafeInteger(message.revision)
          && message.revision >= 0
          && message.revision > Number(authoritativeDocumentRef.current?.revision || 0))) {
          void recoverCanvas(Number(message.revision) || 0).catch((error) => {
            if (!isCurrent(socket)) return;
            setStatus(error instanceof Error ? error.message : String(error));
            socket.close(4000, 'heartbeat sync failed');
          });
        }
        return;
      }
      if (message.type === 'gateway.stopping') {
        gatewayNotice = {
          reason: message.reason,
          retryable: message.retryable === true,
          retryAfterMs: Number(message.retryAfterMs) || 0,
        };
        const decision = classifyCollaborationClose(
          message.reason === 'gateway_restarted' ? 1012 : 4004,
          '',
          gatewayNotice,
        );
        updateConnectionState(decision.phase, decision.message, reconnectAttempt);
        return;
      }
      if (message.type === 'connection.rate-limited'
        && message.code === 'collaboration_ws_message_rate_limited') {
        gatewayNotice = {
          reason: 'message_rate_limited',
          retryable: true,
          retryAfterMs: Number(message.retryAfterMs) || 1_000,
        };
        const decision = classifyCollaborationClose(1013, '', gatewayNotice);
        updateConnectionState(decision.phase, decision.message, reconnectAttempt);
        return;
      }
      if (message.type === 'canvas.joined') {
        if (message.canvasId !== session.canvasId
          || typeof message.revision !== 'number'
          || !Number.isSafeInteger(message.revision)
          || message.revision < 0) {
          updateConnectionState('blocked', 'WebSocket 加入了错误的画布作用域，已停止连接。');
          socket.close(1008, 'canvas scope mismatch');
          return;
        }
        joined = true;
        clearHandshakeTimer();
        updateConnectionState('syncing', `已加入画布，正在恢复到 revision ${message.revision}…`, reconnectAttempt);
        startHeartbeat(socket);
        try {
          await recoverCanvas(Number(message.revision));
          await initializeCollaborationRuns(session);
          await syncCollaborationRuns(session);
          if (!isCurrent(socket) || !joined || socket.readyState !== WebSocket.OPEN) return;
          updateConnectionState(
            'online',
            `协作在线 · revision ${authoritativeDocumentRef.current?.revision || message.revision}`,
            reconnectAttempt,
          );
          sendPresence(socket);
          await flushOfflineQueue();
          if (!isCurrent(socket)
            || !joined
            || socket.readyState !== WebSocket.OPEN
            || connectionStateRef.current.phase !== 'online') return;
          reconnectAttempt = 0;
          updateConnectionState(
            'online',
            `协作在线 · revision ${authoritativeDocumentRef.current?.revision || message.revision}`,
            0,
          );
        } catch (error) {
          if (!isCurrent(socket)) return;
          setStatus(error instanceof Error ? error.message : String(error));
          socket.close(4000, 'canvas sync failed');
        }
        return;
      }
      if (
        ['canvas.operations', 'canvas.patch', 'canvas.snapshot-restored'].includes(String(message.type))
        && message.canvasId === session.canvasId
      ) {
        void recoverCanvas(Number(message.revision) || 0).catch((error) => {
          if (!isCurrent(socket)) return;
          setStatus(error instanceof Error ? error.message : String(error));
          socket.close(4000, 'canvas invalidation sync failed');
        });
      }
      if (message.type === 'collaboration.text-update') {
        try {
          const normalized = normalizeCollaborationTextGatewayEvent(message);
          const currentRevision = Number(authoritativeDocumentRef.current?.revision || 0);
          const registry = textRegistryRef.current;
          const action = collaborationTextGatewayRevisionAction(normalized, {
            projectId: session.projectId,
            canvasId: session.canvasId,
            currentRevision,
            recoveryInFlight: syncTaskRef.current?.scopeGeneration === scopeGeneration,
            authorityBaselineMatches: registry?.authorityBaselineMatches(
              normalized.envelope,
              currentRevision,
            ) === true,
          });
          if (action === 'ignore') return;
          if (action === 'recover') {
            void recoverCanvas(normalized.revision).then(async () => {
              if (!isCurrent(socket) || normalized.envelope.targetType !== 'review') return;
              if (isCurrent(socket)) setReviewRefreshToken((current) => current + 1);
            }).catch((error) => {
              if (!isCurrent(socket)) return;
              setStatus(error instanceof Error ? error.message : String(error));
              socket.close(4000, 'text revision recovery failed');
            });
            return;
          }
          const applied = registry?.applyGatewayEvent(message)
            ?? { ...normalized, handled: false, view: null, authoritativeText: null };
          if (applied.handled && applied.authoritativeText != null) {
            acceptTextMaterialization(
              applied.envelope,
              applied.authoritativeText,
              applied.revision,
            );
          } else {
            void recoverCanvas(applied.revision).catch((error) => {
              if (!isCurrent(socket)) return;
              setStatus(error instanceof Error ? error.message : String(error));
              socket.close(4000, 'text revision recovery failed');
            });
          }
          if (applied.envelope.targetType === 'review') {
            setReviewRefreshToken((current) => current + 1);
          }
        } catch (error) {
          setStatus(error instanceof Error ? error.message : String(error));
          socket.close(1008, 'invalid collaboration text event');
        }
        return;
      }
      if (message.type === 'subflow.published') {
        const subflowScopeGeneration = queueScopeGenerationRef.current;
        const subflowRecoveryGeneration = normalizeCollaborationRecoveryGeneration(
          authoritativeGenerationRef.current,
        );
        const isCurrentSubflowScope = () => (
          isCurrent(socket)
          && subflowScopeGeneration === queueScopeGenerationRef.current
          && subflowRecoveryGeneration !== null
          && subflowRecoveryGeneration === normalizeCollaborationRecoveryGeneration(
            authoritativeGenerationRef.current,
          )
        );
        void loadSubflows(isCurrentSubflowScope).catch((error) => {
          if (isCurrentSubflowScope()) setStatus(error instanceof Error ? error.message : String(error));
        });
        const publication = message.publication || {};
        setStatus(`${publication.publishedBy || '协作者'} 已发布 ${publication.name || publication.id} v${publication.version} / revision ${publication.revision}`);
      }
      if (['review.created', 'review.updated', 'review.comment', 'review.notification', 'notification.created'].includes(String(message.type))) {
        setReviewRefreshToken((current) => current + 1);
      }
      if (['run.intent', 'run.intent-state'].includes(String(message.type))
        && message.intent?.canvasId === session.canvasId) {
        const intent = normalizeCollaborationRunIntentView(message.intent, session.canvasId);
        if (!intent) {
          socket.close(1008, 'invalid run intent event');
          return;
        }
        if (intent.requestedBy === session.memberId) {
          setOwnRunIntents((current) => ({
            ...current,
            [intent.id]: mergeCollaborationRunIntentView(current[intent.id], intent),
          }));
        }
        setStatus(`运行请求 ${intent.id.slice(0, 8)}：${intent.status}${intent.runId ? ` · Run ${intent.runId.slice(0, 8)}` : ''}`);
      }
      if (message.type === 'run.state' && message.run?.canvasId === session.canvasId) {
        const run = normalizeCollaborationRun(message.run, session.canvasId, message.timestamp);
        if (!run) {
          socket.close(1008, 'invalid run state event');
          return;
        }
        setSharedRuns((current) => withMergedCollaborationRun(current, run));
        void loadSharedRunDetail(run.id, {
          scopeKey: collaborationRunScopeKey(session, authoritativeGenerationRef.current),
        }).catch(() => undefined);
        setStatus(`主机 Run ${run.id.slice(0, 8)}：${run.status}`);
      }
      if (message.type === 'run.node-state' && message.runId && message.node?.id) {
        const runId = boundedCollaborationRunText(message.runId, 240);
        const node = normalizeCollaborationRunNode(message.node, runId);
        if (!runId || !node) {
          socket.close(1008, 'invalid node run state event');
          return;
        }
        setSharedRuns((current) => {
          const existing = current[runId];
          if (!existing) return current;
          return withMergedCollaborationRun(current, {
            ...existing,
            nodes: [node],
            updatedAt: Math.max(existing.updatedAt, collaborationRunTimestamp(message.timestamp) || Date.now()),
          });
        });
        void loadSharedRunDetail(runId, {
          scopeKey: collaborationRunScopeKey(session, authoritativeGenerationRef.current),
        }).catch(() => undefined);
      }
      if (message.type === 'run.output' && message.runId && Array.isArray(message.assets)) {
        const runId = boundedCollaborationRunText(message.runId, 240);
        const assets = (message.assets as unknown[])
          .map(normalizeCollaborationRunAsset)
          .filter((asset): asset is CollaborationRunAsset => Boolean(asset));
        if (!runId || assets.length !== message.assets.length) {
          socket.close(1008, 'invalid run output event');
          return;
        }
        setSharedRuns((current) => {
          const existing = current[runId];
          if (!existing) return current;
          return withMergedCollaborationRun(current, {
            ...existing,
            assets,
            updatedAt: Math.max(existing.updatedAt, collaborationRunTimestamp(message.timestamp) || Date.now()),
          });
        });
        void loadSharedRunDetail(runId, {
          scopeKey: collaborationRunScopeKey(session, authoritativeGenerationRef.current),
        }).catch(() => undefined);
      }
      if (message.type === 'run.event' && message.event) {
        const runEvent = normalizeCollaborationRunEvent(message.event);
        if (!runEvent) {
          socket.close(1008, 'invalid run event');
          return;
        }
        setSharedRuns((current) => boundedCollaborationRuns(
          mergeCollaborationRunEvent(current, runEvent, session.canvasId),
        ));
        void loadSharedRunDetail(runEvent.runId, {
          scopeKey: collaborationRunScopeKey(session, authoritativeGenerationRef.current),
        }).catch(() => undefined);
      }
      if (message.type === 'presence.snapshot' && message.canvasId === session.canvasId && Array.isArray(message.members)) {
        const snapshot: Record<string, Presence> = {};
        for (const member of message.members) {
          if (!member?.memberId) continue;
          if (localConnectionId
            ? String(member.connectionId || '') === localConnectionId
            : member.memberId === session.memberId) continue;
          const key = collaborationPresenceKey(member.memberId, member.connectionId);
          snapshot[key] = {
            ...(member.presence || {}),
            memberId: member.memberId,
            displayName: member.displayName,
            connectionId: member.connectionId,
          };
        }
        setPresence(snapshot);
      }
      if (message.type === 'presence.update'
        && (localConnectionId
          ? String(message.connectionId || '') !== localConnectionId
          : message.memberId !== session.memberId)) {
        const key = collaborationPresenceKey(message.memberId, message.connectionId);
        setPresence((current) => ({
          ...current,
          [key]: {
            ...(message.presence || {}),
            memberId: message.memberId,
            displayName: message.displayName,
            connectionId: message.connectionId,
          },
        }));
      }
      if (message.type === 'presence.left') {
        setPresence((current) => {
          const next = { ...current };
          if (message.connectionId) {
            delete next[collaborationPresenceKey(message.memberId, message.connectionId)];
          } else {
            for (const [key, existing] of Object.entries(next)) {
              if (existing.memberId === message.memberId) delete next[key];
            }
          }
          return next;
        });
      }
      if (message.type === 'session.revoked') {
        updateConnectionState('revoked', '主机已撤销当前协作会话，请重新获取邀请链接。');
      }
      if (message.type === 'session.changed') void refreshSessionAfterRoleChange();
    };
    const connect = () => {
      if (!isCurrent()) return;
      clearReconnectTimer();
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        updateConnectionState('offline', '浏览器当前离线；恢复网络后将自动重新连接。', reconnectAttempt);
        return;
      }
      joined = false;
      pendingHeartbeatNonce = '';
      gatewayNotice = null;
      roleRefreshStarted = false;
      updateConnectionState(
        reconnectAttempt > 0 ? 'reconnecting' : 'connecting',
        reconnectAttempt > 0 ? '正在重新连接协作网关…' : '正在连接协作网关…',
        reconnectAttempt,
      );
      const socket = new WebSocket(webSocketUrl);
      activeSocket = socket;
      webSocketRef.current = socket;
      armHandshakeTimer(socket, 'connect');
      socket.onopen = () => {
        if (!isCurrent(socket)) return;
        armHandshakeTimer(socket, 'join');
        updateConnectionState('joining', 'WebSocket 已连接，正在加入授权画布…', reconnectAttempt);
        socket.send(JSON.stringify({
          type: 'canvas.join',
          canvasId: session.canvasId,
          afterRevision: authoritativeDocumentRef.current?.revision || 0,
          ...(authoritativeGenerationRef.current
            ? { generation: authoritativeGenerationRef.current }
            : {}),
        }));
      };
      socket.onmessage = (event) => {
        void handleMessage(socket, event).catch((error) => {
          if (!isCurrent(socket)) return;
          setStatus(error instanceof Error ? error.message : String(error));
          socket.close(4000, 'message handling failed');
        });
      };
      socket.onerror = () => {
        if (!isCurrent(socket)) return;
        updateConnectionState('reconnecting', '协作连接发生网络错误，等待关闭后重试。', reconnectAttempt);
      };
      socket.onclose = (event) => {
        if (!isCurrent(socket)) return;
        clearHeartbeatTimer();
        clearHandshakeTimer();
        pendingHeartbeatNonce = '';
        joined = false;
        setPresence({});
        if (webSocketRef.current === socket) webSocketRef.current = null;
        const decision = classifyCollaborationClose(event.code, event.reason, gatewayNotice);
        if (decision.action === 'refresh-session') {
          updateConnectionState(decision.phase, decision.message, reconnectAttempt);
          void refreshSessionAfterRoleChange();
          return;
        }
        if (decision.action === 'retry') {
          scheduleReconnect(decision.message, decision.retryAfterMs);
          return;
        }
        updateConnectionState(decision.phase, decision.message, reconnectAttempt);
      };
    };
    const handleBrowserOffline = () => {
      if (!isCurrent()) return;
      clearReconnectTimer();
      updateConnectionState('offline', '浏览器已离线；未提交操作已保留，恢复网络后继续连接。', reconnectAttempt);
      if (activeSocket
        && (activeSocket.readyState === WebSocket.CONNECTING || activeSocket.readyState === WebSocket.OPEN)) {
        activeSocket.close(4000, 'browser offline');
      }
    };
    const handleBrowserOnline = () => {
      if (!isCurrent()) return;
      clearReconnectTimer();
      if (!activeSocket
        || activeSocket.readyState === WebSocket.CLOSED
        || activeSocket.readyState === WebSocket.CLOSING) connect();
    };
    retryConnectionRef.current = () => {
      if (!isCurrent()) return;
      clearReconnectTimer();
      reconnectAttempt = 0;
      if (activeSocket
        && (activeSocket.readyState === WebSocket.CONNECTING || activeSocket.readyState === WebSocket.OPEN)) {
        activeSocket.close(4000, 'manual reconnect');
      } else {
        connect();
      }
    };
    window.addEventListener('offline', handleBrowserOffline);
    window.addEventListener('online', handleBrowserOnline);
    connect();
    return () => {
      disposed = true;
      if (socketGenerationRef.current === generation) socketGenerationRef.current += 1;
      clearReconnectTimer();
      clearHeartbeatTimer();
      clearHandshakeTimer();
      window.removeEventListener('offline', handleBrowserOffline);
      window.removeEventListener('online', handleBrowserOnline);
      retryConnectionRef.current = null;
      if (activeSocket
        && (activeSocket.readyState === WebSocket.CONNECTING || activeSocket.readyState === WebSocket.OPEN)) {
        activeSocket.close(1000, 'workspace changed');
      }
      if (webSocketRef.current === activeSocket) webSocketRef.current = null;
    };
  }, [
    acceptTextMaterialization,
    activateQueueScope,
    commitOfflineQueue,
    flushOfflineQueue,
    initializeCollaborationRuns,
    loadCanvas,
    loadSharedRunDetail,
    loadSubflows,
    queueScopeVersion,
    recoverCanvas,
    session,
    socketScopeReady,
    syncCollaborationRuns,
    updateConnectionState,
  ]);

  useEffect(() => {
    if (!session || !socketScopeReady || connectionState.phase !== 'online') return;
    const socket = webSocketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    const identity = collaborationSessionHeartbeatIdentity(session);
    if (!identity) {
      updateConnectionState('blocked', '协作会话身份不完整，已停止连接以避免错误续期。', 0);
      socket.close(1008, 'invalid session heartbeat identity');
      return;
    }

    const generation = ++sessionHeartbeatGenerationRef.current;
    const singleFlight = sessionHeartbeatSingleFlight;
    let disposed = false;
    let timer: number | null = null;

    const isCurrent = () => {
      if (disposed
        || sessionHeartbeatGenerationRef.current !== generation
        || webSocketRef.current !== socket
        || socket.readyState !== WebSocket.OPEN
        || connectionStateRef.current.phase !== 'online') return false;
      return sameCollaborationSessionHeartbeatIdentity(
        identity,
        collaborationSessionHeartbeatIdentity(sessionRef.current),
      );
    };
    const clearTimer = () => {
      if (timer === null) return;
      window.clearTimeout(timer);
      timer = null;
    };
    const schedule = (callback: () => void) => {
      clearTimer();
      if (!isCurrent()) return;
      timer = window.setTimeout(callback, COLLABORATION_SESSION_HEARTBEAT_INTERVAL_MS);
    };
    const heartbeat = async () => {
      if (!isCurrent()) return;
      try {
        await singleFlight.run(generation, async (signal) => {
          // A new generation can be waiting for an older aborted request to
          // settle. Re-check after that wait so cleanup/offline transitions
          // cannot start a stale durable request.
          if (signal.aborted || !isCurrent()) return;
          try {
            const mutationFence = captureMutationFence();
            await collabRequest<{
              touched: boolean;
              lastSeenAt: number;
              nextHeartbeatAt: number;
            }>('/api/collab/session/heartbeat', {
              method: 'POST',
              body: JSON.stringify(identity),
              signal,
            }, {
              recoveryGeneration: null,
              assertCurrent: () => assertMutationFenceCurrent(mutationFence),
            });
          } catch (error) {
            if (signal.aborted || !isCurrent()) return;
            if ((error as { code?: unknown })?.code === 'collaboration_mutation_scope_changed') return;
            const action = classifyCollaborationSessionHeartbeatFailure(error);
            if (action === 'revoke') {
              updateConnectionState('revoked', '当前协作会话已撤销或过期，请重新获取邀请链接。', 0);
              socket.close(4001, 'session heartbeat unauthorized');
              return;
            }
            if (action === 'block') {
              updateConnectionState('blocked', '当前协作会话心跳被安全策略拒绝，请联系主机检查访问范围。', 0);
              socket.close(1008, 'session heartbeat forbidden');
              return;
            }
            if (action === 'refresh-session') {
              updateConnectionState('reconnecting', '协作权限已变化，正在刷新会话后重新连接。', 0);
              socket.close(4002, 'session heartbeat identity changed');
              return;
            }
            // Capacity pressure, rate limits and transient network failures must
            // never interrupt creation. The WebSocket liveness loop remains
            // independent and the next durable heartbeat retries on this cadence.
            console.warn('[collaboration] durable session heartbeat deferred');
          }
        });
      } catch {
        if (isCurrent()) console.warn('[collaboration] durable session heartbeat deferred');
      } finally {
        schedule(() => { void heartbeat(); });
      }
    };

    void heartbeat();
    return () => {
      disposed = true;
      if (sessionHeartbeatGenerationRef.current === generation) {
        sessionHeartbeatGenerationRef.current += 1;
      }
      clearTimer();
      singleFlight.cancel(generation);
    };
  }, [
    assertMutationFenceCurrent,
    captureMutationFence,
    connectionState.phase,
    session,
    sessionHeartbeatSingleFlight,
    socketScopeReady,
    updateConnectionState,
  ]);

  const restoreVisibleNodes = useCallback(() => {
    const authoritative = authoritativeDocumentRef.current;
    if (authoritative) updateVisibleDocument(authoritative);
  }, [updateVisibleDocument]);

  const sendLocalPresence = useCallback(() => {
    const socket = webSocketRef.current;
    if (connectionStateRef.current.phase !== 'online' || socket?.readyState !== WebSocket.OPEN) {
      return false;
    }
    socket.send(JSON.stringify({
      type: 'presence.update',
      presence: localPresenceRef.current,
    }));
    return true;
  }, []);

  const sendOperations = useCallback((operations: Array<{ type: string; payload: Record<string, unknown> }>) => {
    const currentSession = sessionRef.current;
    if (!authoritativeDocumentRef.current || !currentSession?.capabilities.includes('editGraph')) {
      restoreVisibleNodes();
      setSaveState({ phase: 'blocked', message: '当前会话没有画布编辑能力，本次移动已恢复。' });
      return false;
    }
    const activeScope = collaborationQueueScope(
      currentSession,
      authoritativeGenerationRef.current,
    );
    if (!sameCollaborationQueueScope(activeScope, queueScopeRef.current)) {
      setSaveState({ phase: 'blocked', message: '协作队列作用域正在切换，本次移动未加入旧作用域。' });
      restoreVisibleNodes();
      return false;
    }
    const scopeGeneration = queueScopeGenerationRef.current;
    let nextQueue = offlineQueueRef.current;
    for (const operation of operations) {
      if (operation.type !== 'node.move') {
        setSaveState({ phase: 'blocked', message: `F2 离线队列不支持 ${operation.type}` });
        restoreVisibleNodes();
        return false;
      }
      const payload = operation.payload || {};
      const position = payload.position as { x?: unknown; y?: unknown } | undefined;
      const sequence = seqRef.current++;
      const timestamp = Date.now();
      const opId = `move:${clientInstanceIdRef.current}:${timestamp}:${sequence}`;
      const result = enqueueCollaborationOperation(nextQueue, {
        id: opId,
        operation: {
          opId,
          clientSeq: sequence,
          timestamp,
          type: 'node.move',
          payload: {
            nodeId: String(payload.nodeId || ''),
            position: {
              x: Number(position?.x),
              y: Number(position?.y),
            },
          },
        },
        baseRevision: null,
        status: 'pending',
        ambiguous: false,
        attempts: 0,
        rebaseAttempts: 0,
      });
      if (!result.accepted) {
        restoreVisibleNodes();
        const reason = result.reason === 'operation_limit'
          ? '离线队列已达到 200 条上限'
          : result.reason === 'byte_limit'
            ? '离线队列已达到 256 KiB 上限'
            : '画布移动无法安全加入离线队列';
        setSaveState({ phase: 'blocked', message: `${reason}，本次移动未标记为已保存` });
        setStatus(`${reason}；已恢复到最后确认状态`);
        return false;
      }
      nextQueue = result.queue;
    }
    if (!commitOfflineQueue(nextQueue, scopeGeneration)) {
      restoreVisibleNodes();
      return false;
    }
    setSaveState(saveViewForQueue(nextQueue));
    if (connectionStateRef.current.phase === 'online') {
      void flushOfflineQueue().catch((error) => {
        setStatus(error instanceof Error ? error.message : String(error));
        const socket = webSocketRef.current;
        if (socket?.readyState === WebSocket.OPEN) socket.close(4000, 'queue replay failed');
      });
    }
    return true;
  }, [commitOfflineQueue, flushOfflineQueue, restoreVisibleNodes]);

  const submitStructuralOperations = useCallback((
    drafts: CollaborationOperationDraft[],
    description: string,
  ): Promise<boolean> => {
    const run = async () => {
      if (!drafts.length || drafts.some((draft) => draft.type === 'node.move')) return false;
      const initialSession = sessionRef.current;
      const scopeGeneration = queueScopeGenerationRef.current;
      if (!initialSession?.capabilities.includes('editGraph')) {
        restoreVisibleNodes();
        setStatus('当前会话没有结构编辑能力。');
        return false;
      }
      if (connectionStateRef.current.phase !== 'online') {
        restoreVisibleNodes();
        setStatus(`${description}需要在线连接；F2 本地队列仍只保存最终 node.move。`);
        return false;
      }
      setStructureBusy(true);
      try {
        if (offlineQueueRef.current.length > 0) await flushOfflineQueue();
        if (scopeGeneration !== queueScopeGenerationRef.current) return false;
        if (offlineQueueRef.current.length > 0) {
          restoreVisibleNodes();
          setStatus(`${description}已暂停：请先处理严格 FIFO 中的移动操作。`);
          return false;
        }
        for (let rebaseAttempt = 0; rebaseAttempt <= 3; rebaseAttempt += 1) {
          if (scopeGeneration !== queueScopeGenerationRef.current) return false;
          const currentSession = sessionRef.current;
          const authoritative = authoritativeDocumentRef.current;
          if (!currentSession
            || !authoritative
            || !currentSession.capabilities.includes('editGraph')
            || connectionStateRef.current.phase !== 'online') {
            restoreVisibleNodes();
            return false;
          }
          const baseRevision = authoritative.revision;
          const clientSeq = seqRef.current;
          seqRef.current += drafts.length;
          const commonBatch = buildCommonGraphBatch({
            document: authoritative,
            batchId: createCanvasEntityUid(),
            clientId: clientInstanceIdRef.current,
            clientSeq,
            drafts: drafts.map((draft) => ({
              opId: createCanvasEntityUid(),
              type: draft.type,
              payload: draft.payload,
            })),
          });
          const mutationFence = captureMutationFence();
          const requestBody = JSON.stringify(commonBatch);
          for (let exactRetry = 0; exactRetry < 2; exactRetry += 1) {
            try {
              const result = await collaborationMutationRequest<unknown>(
                mutationFence,
                `/api/collab/canvases/${encodeURIComponent(authoritative.canvasId)}/operations`,
                { method: 'POST', body: requestBody },
              );
              if (scopeGeneration !== queueScopeGenerationRef.current) return false;
              const confirmed = acceptCommonCollaborationMutationResult(result, commonBatch, {
                projectId: currentSession.projectId,
                canvasId: authoritative.canvasId,
                memberId: currentSession.memberId,
              });
              if (!acceptAuthoritativeDocument(confirmed.document)) return false;
              setStatus(`${description}已保存到 revision ${confirmed.document.revision}`);
              setSaveState(saveViewForQueue(offlineQueueRef.current, confirmed.document.revision));
              return true;
            } catch (error: any) {
              if (scopeGeneration !== queueScopeGenerationRef.current) return false;
              if (error instanceof CollaborationSyncFallbackError) {
                await recoverCanvas(authoritativeDocumentRef.current?.revision || baseRevision);
                setStatus(`${description}的确认响应未通过严格校验，已恢复权威画布。`);
                return false;
              }
              if (error?.status === 409 && [
                'canvas_generation_required',
                'canvas_generation_changed',
                'revision_conflict',
                'common_operation_revision_conflict',
                'common_operation_cas_conflict',
              ].includes(String(error?.code || ''))) {
                if (rebaseAttempt >= 3) {
                  setStatus(`${description}连续发生 revision 冲突，已在 3 次安全重基后停止。`);
                  return false;
                }
                await recoverCanvas(Number(error?.currentRevision) || 0);
                break;
              }
              if (isDefinitiveCollaborationOperationRejection(error)) {
                restoreVisibleNodes();
                setStatus(`${description}被主机拒绝：${error instanceof Error ? error.message : String(error)}`);
                return false;
              }
              if (exactRetry === 0 && connectionStateRef.current.phase === 'online') {
                setStatus(`${description}结果未知，正在使用原批次身份精确重试。`);
                continue;
              }
              restoreVisibleNodes();
              updateConnectionState('offline', `${description}结果未知；未写入离线队列，重连后将从主机恢复。`);
              const socket = webSocketRef.current;
              if (socket?.readyState === WebSocket.OPEN) socket.close(4000, 'structural mutation unavailable');
              return false;
            }
          }
        }
        return false;
      } finally {
        setStructureBusy(false);
      }
    };
    const queued = structureMutationTailRef.current.then(run, run);
    structureMutationTailRef.current = queued.then(() => undefined, () => undefined);
    return queued;
  }, [
    acceptAuthoritativeDocument,
    captureMutationFence,
    collaborationMutationRequest,
    flushOfflineQueue,
    recoverCanvas,
    restoreVisibleNodes,
    updateConnectionState,
  ]);

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    const permittedChanges = changes.filter((change) => (
      change.type === 'select'
      || change.type === 'dimensions'
      || (canEdit && change.type === 'position')
    ));
    if (!permittedChanges.length) return;
    setNodes((current) => applyNodeChanges(permittedChanges, current));
  }, [canEdit]);

  const beginLocalDrag: NodeMouseHandler = useCallback((_event, node) => {
    if (!canEdit) {
      restoreVisibleNodes();
      return;
    }
    const now = Date.now();
    localDragRef.current = {
      nodeId: String(node.id),
      dragId: `drag:${clientInstanceIdRef.current}:${now}:${seqRef.current}`,
      seq: 0,
      position: { x: node.position.x, y: node.position.y },
      finalCommitted: false,
      lastSentAt: Number.NEGATIVE_INFINITY,
    };
  }, [canEdit, restoreVisibleNodes]);

  const previewLocalDrag: NodeMouseHandler = useCallback((_event, node) => {
    if (!canEdit) return;
    const current = localDragRef.current;
    if (!current || current.nodeId !== String(node.id) || current.finalCommitted) {
      beginLocalDrag(_event, node);
    }
    const active = localDragRef.current;
    if (!active) return;
    const now = Date.now();
    const next = {
      ...active,
      seq: active.seq + 1,
      position: { x: node.position.x, y: node.position.y },
    };
    localDragRef.current = next;
    localPresenceRef.current = collaborationPresenceWithDrag(localPresenceRef.current, next);
    if (shouldSendCollaborationDragPreview(next.lastSentAt, now) && sendLocalPresence()) {
      localDragRef.current = { ...next, lastSentAt: now };
    }
  }, [beginLocalDrag, canEdit, sendLocalPresence]);

  const finalizeLocalDrag = useCallback((node?: Node) => {
    const active = localDragRef.current;
    if (!active || active.finalCommitted) return false;
    const position = node && String(node.id) === active.nodeId
      ? { x: node.position.x, y: node.position.y }
      : active.position;
    localDragRef.current = { ...active, position, finalCommitted: true };
    localPresenceRef.current = collaborationPresenceWithDrag(localPresenceRef.current, null);
    sendLocalPresence();
    if (!canEdit) {
      restoreVisibleNodes();
      return false;
    }
    return sendOperations([{
      type: 'node.move',
      payload: { nodeId: active.nodeId, position },
    }]);
  }, [canEdit, restoreVisibleNodes, sendLocalPresence, sendOperations]);

  const onNodeDragStop: NodeMouseHandler = useCallback((_event, node) => {
    finalizeLocalDrag(node);
  }, [finalizeLocalDrag]);

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    const permittedChanges = changes.filter((change) => change.type === 'select');
    if (!permittedChanges.length) return;
    setEdges((current) => applyEdgeChanges(permittedChanges, current));
  }, []);

  const validateConnection = useCallback((connection: Connection | Edge) => {
    if (!canEdit || !connection.source || !connection.target) return false;
    const source = nodes.find((node) => String(node.id) === String(connection.source));
    const target = nodes.find((node) => String(node.id) === String(connection.target));
    if (!source || !target) return false;
    const signatureAlreadyExists = edges.some((edge) => (
      String(edge.source) === String(connection.source)
      && String(edge.target) === String(connection.target)
      && (edge.sourceHandle ?? null) === (connection.sourceHandle ?? null)
      && (edge.targetHandle ?? null) === (connection.targetHandle ?? null)
    ));
    return !signatureAlreadyExists && isConnectionValid(
      originalCollaborationNode(source),
      originalCollaborationNode(target),
      {
        sourceHandle: connection.sourceHandle ?? null,
        targetHandle: connection.targetHandle ?? null,
      },
      edges,
    );
  }, [canEdit, edges, nodes]);

  const connectNodes = useCallback((connection: Connection) => {
    if (!validateConnection(connection)) {
      setStatus('连线被本地端口契约拒绝；主机仍会对所有结构操作再次权威校验。');
      return;
    }
    const edgeId = `edge:${globalThis.crypto?.randomUUID?.()
      || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}`;
    void submitStructuralOperations(
      [collaborationEdgeAddDraft(connection, edgeId)],
      '新增连线',
    );
  }, [submitStructuralOperations, validateConnection]);

  const deleteElements = useCallback((deleted: { nodes: Node[]; edges: Edge[] }) => {
    if (!canEdit) {
      restoreVisibleNodes();
      return;
    }
    const drafts = collaborationDeleteDrafts(deleted.nodes, deleted.edges);
    if (drafts.length) void submitStructuralOperations(drafts, '删除选中结构');
  }, [canEdit, restoreVisibleNodes, submitStructuralOperations]);

  const deleteSelectedElements = useCallback(() => {
    deleteElements({
      nodes: nodes.filter((node) => node.selected),
      edges: edges.filter((edge) => edge.selected),
    });
  }, [deleteElements, edges, nodes]);

  const addTextNode = useCallback(() => {
    const authoritative = authoritativeDocumentRef.current;
    if (!authoritative || !canEdit) return;
    const viewport = authoritative.viewport || { x: 0, y: 0, zoom: 1 };
    const zoom = Number.isFinite(viewport.zoom) && viewport.zoom > 0 ? viewport.zoom : 1;
    const ordinal = authoritative.nodes.length;
    const position = {
      x: (-Number(viewport.x || 0) + 120) / zoom + (ordinal % 6) * 24,
      y: (-Number(viewport.y || 0) + 100) / zoom + (ordinal % 5) * 24,
    };
    const nodeId = `node:${globalThis.crypto?.randomUUID?.()
      || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}`;
    void submitStructuralOperations(
      [collaborationTextNodeAddDraft(nodeId, position)],
      '新增文本节点',
    );
  }, [canEdit, submitStructuralOperations]);

  const renameSelectedNode = useCallback(() => {
    if (!canEdit || connectionStateRef.current.phase !== 'online' || !selectedNodeId) return;
    const selected = nodes.find((node) => String(node.id) === selectedNodeId) as (
      Node & { entityUid?: string }
    ) | undefined;
    if (!selected) return;
    const targetEntityUid = String(selected.entityUid || '');
    if (!targetEntityUid) {
      setStatus('当前节点缺少稳定 entityUid，不能编辑协同标题。');
      return;
    }
    const key = collaborationWorkspaceTextKey({
      targetType: 'node',
      targetEntityUid,
      field: 'title',
    });
    const activeView = visibleTextViews[key];
    if (!activeView) {
      setStatus('节点标题绑定仍在载入，请稍后重试。');
      return;
    }
    const nextTitle = window.prompt('输入节点标题（最多 512 字）', activeView.text);
    if (nextTitle == null || nextTitle === activeView.text) return;
    if (nextTitle.length > 512) {
      setStatus('节点标题不能超过 512 字。');
      return;
    }
    try {
      textRegistryRef.current?.replaceText(key, nextTitle);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }, [canEdit, nodes, selectedNodeId, visibleTextViews]);

  const restoreDeletedNode = useCallback((nodeId: string) => {
    const authoritative = authoritativeDocumentRef.current;
    const tombstone = authoritative?.tombstones.nodes[nodeId];
    if (!authoritative || !tombstone || !canEdit) return;
    const ordinal = Object.keys(authoritative.tombstones.nodes).indexOf(nodeId);
    try {
      void submitStructuralOperations([
        collaborationRestoreNodeDraft(nodeId, tombstone as unknown as Record<string, unknown>, {
          x: 80 + Math.max(0, ordinal) * 32,
          y: 80 + Math.max(0, ordinal) * 24,
        }),
      ], '恢复节点');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }, [canEdit, submitStructuralOperations]);

  const restoreDeletedEdge = useCallback((edgeId: string) => {
    const tombstone = authoritativeDocumentRef.current?.tombstones.edges[edgeId];
    if (!tombstone || !canEdit) return;
    try {
      void submitStructuralOperations([
        collaborationRestoreEdgeDraft(edgeId, tombstone as unknown as Record<string, unknown>),
      ], '恢复连线');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }, [canEdit, submitStructuralOperations]);

  useEffect(() => {
    localDragRef.current = null;
    localPresenceRef.current = collaborationPresenceWithDrag(localPresenceRef.current, null);
  }, [canvasId, session?.id]);

  useEffect(() => {
    const active = localDragRef.current;
    if (canEdit || !active || active.finalCommitted) return;
    localPresenceRef.current = collaborationPresenceWithDrag(localPresenceRef.current, null);
    localDragRef.current = null;
    sendLocalPresence();
    restoreVisibleNodes();
  }, [canEdit, restoreVisibleNodes, sendLocalPresence]);

  const manualRecoverCanvas = useCallback(async () => {
    if (!sessionRef.current?.canvasId || !authoritativeDocumentRef.current) return;
    const scopeGeneration = queueScopeGenerationRef.current;
    setBusy(true);
    setStatus('正在从主机重新同步权威画布…');
    try {
      await recoverCanvas(authoritativeDocumentRef.current.revision);
      if (scopeGeneration !== queueScopeGenerationRef.current) return;
      setStatus(`已重新同步 revision ${authoritativeDocumentRef.current?.revision || 0}`);
      setSaveState(saveViewForQueue(offlineQueueRef.current));
      if (connectionStateRef.current.phase === 'online') await flushOfflineQueue();
    } catch (error) {
      if (scopeGeneration !== queueScopeGenerationRef.current) return;
      const message = error instanceof Error ? error.message : String(error);
      setStatus(message);
    } finally {
      if (scopeGeneration === queueScopeGenerationRef.current) setBusy(false);
    }
  }, [flushOfflineQueue, recoverCanvas]);

  const retryBlockedQueueItem = useCallback(async (itemId: string) => {
    const currentSession = sessionRef.current;
    if (!currentSession?.capabilities.includes('editGraph')) return;
    const scopeGeneration = queueScopeGenerationRef.current;
    try {
      await recoverCanvas(authoritativeDocumentRef.current?.revision || 0);
      if (scopeGeneration !== queueScopeGenerationRef.current) return;
      const live = offlineQueueRef.current.find((item) => item.id === itemId && item.status === 'blocked');
      if (!live) return;
      const next = updateCollaborationQueueItem(offlineQueueRef.current, itemId, {
        baseRevision: live.ambiguous ? live.baseRevision : null,
        status: 'pending',
        ambiguous: live.ambiguous,
        rebaseAttempts: live.ambiguous ? live.rebaseAttempts : 0,
        error: live.ambiguous
          ? '上次提交结果未知；将使用原 opId、clientSeq、baseRevision 与 payload 精确重试。'
          : undefined,
      });
      if (!commitOfflineQueue(next, scopeGeneration)) return;
      setSaveState(saveViewForQueue(next));
      if (connectionStateRef.current.phase === 'online') await flushOfflineQueue();
    } catch (error) {
      if (scopeGeneration !== queueScopeGenerationRef.current) return;
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }, [commitOfflineQueue, flushOfflineQueue, recoverCanvas]);

  const discardQueueItem = useCallback((itemId: string) => {
    const next = removeCollaborationQueueItem(offlineQueueRef.current, itemId);
    if (!commitOfflineQueue(next, queueScopeGenerationRef.current)) return;
    setSaveState(saveViewForQueue(next, authoritativeDocumentRef.current?.revision));
    if (connectionStateRef.current.phase === 'online' && firstCollaborationQueueItemForReplay(next)) {
      void flushOfflineQueue().catch((error) => {
        setStatus(error instanceof Error ? error.message : String(error));
      });
    }
  }, [commitOfflineQueue, flushOfflineQueue]);

  const retryFailedQueuePersistence = useCallback(async () => {
    const failed = failedQueueTransitionRef.current;
    if (!failed || failed.scopeGeneration !== queueScopeGenerationRef.current) return;
    try {
      if (!commitOfflineQueue(failed.queue, failed.scopeGeneration)) return;
      setSaveState(saveViewForQueue(failed.queue, authoritativeDocumentRef.current?.revision));
      if (connectionStateRef.current.phase === 'online') await flushOfflineQueue();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }, [commitOfflineQueue, flushOfflineQueue]);

  const selectedNode = useMemo(() => (
    nodes.find((node) => String(node.id) === selectedNodeId) as (Node & { entityUid?: string }) | undefined
  ), [nodes, selectedNodeId]);
  const selectedEdgeId = String(edges.find((edge) => edge.selected)?.id || '');
  const selectedNodeEntityUid = String(selectedNode?.entityUid || '');
  const selectedNodeTitleKey = selectedNodeEntityUid
    ? collaborationWorkspaceTextKey({
      targetType: 'node',
      targetEntityUid: selectedNodeEntityUid,
      field: 'title',
    })
    : '';
  const selectedNodePromptKey = selectedNodeEntityUid
    ? collaborationWorkspaceTextKey({
      targetType: 'node',
      targetEntityUid: selectedNodeEntityUid,
      field: 'prompt',
    })
    : '';
  const selectedNodeTitleView = selectedNodeTitleKey ? visibleTextViews[selectedNodeTitleKey] : undefined;
  const selectedNodePromptView = selectedNodePromptKey ? visibleTextViews[selectedNodePromptKey] : undefined;
  const editingReviewTextView = editingReviewTextKey
    ? visibleTextViews[editingReviewTextKey]
    : undefined;

  useEffect(() => {
    if (!canEdit
      || connectionState.phase !== 'online'
      || !canvasId
      || !selectedNodeEntityUid) return undefined;
    const controller = new AbortController();
    const capturedSession = sessionRef.current;
    const capturedQueueScopeGeneration = queueScopeGenerationRef.current;
    const capturedRecoveryGeneration = normalizeCollaborationRecoveryGeneration(
      authoritativeGenerationRef.current,
    );
    if (!capturedSession || !capturedRecoveryGeneration) return undefined;
    const isCurrentTextScope = () => {
      const activeSession = sessionRef.current;
      return connectionStateRef.current.phase === 'online'
        && capturedQueueScopeGeneration === queueScopeGenerationRef.current
        && capturedRecoveryGeneration === normalizeCollaborationRecoveryGeneration(
          authoritativeGenerationRef.current,
        )
        && Boolean(activeSession)
        && capturedSession.id === activeSession!.id
        && capturedSession.projectId === activeSession!.projectId
        && capturedSession.canvasId === activeSession!.canvasId
        && capturedSession.authorizationEpoch === activeSession!.authorizationEpoch
        && activeSession!.capabilities.includes('editGraph');
    };
    const descriptors: CollaborationWorkspaceTextDescriptor[] = [
      {
        targetType: 'node',
        targetEntityUid: selectedNodeEntityUid,
        field: 'title',
        displayId: selectedNodeId,
        label: String(selectedNode?.data?.title || selectedNode?.data?.label || selectedNodeId),
        authoritativeText: String(selectedNode?.data?.title || ''),
      },
      {
        targetType: 'node',
        targetEntityUid: selectedNodeEntityUid,
        field: 'prompt',
        displayId: selectedNodeId,
        label: String(selectedNode?.data?.title || selectedNode?.data?.label || selectedNodeId),
        authoritativeText: String(selectedNode?.data?.prompt || ''),
      },
    ];
    void Promise.all(descriptors.map(async (descriptor) => ({
      descriptor,
      result: await loadCollaborationTextBinding(canvasId, capturedSession.projectId, descriptor, {
        signal: controller.signal,
        isCurrentScope: isCurrentTextScope,
        authoritativeText: descriptor.authoritativeText,
      }),
    }))).then((bindings) => {
      if (controller.signal.aborted || !isCurrentTextScope()) return;
      const registry = ensureTextRegistry();
      for (const binding of bindings) {
        if (binding.result.kind === 'recovery') {
          const conflict = collaborationTextLegacyRecoveryConflict(
            binding.result.recovery,
            binding.descriptor,
          );
          if (textDismissedRecoveryIdsRef.current.has(conflict.id)) continue;
          addScopedTextConflict(
            conflict,
            collaborationTextRecoveryScopeKey(capturedSession),
          );
          setStatus('检测到旧 schema 协同正文；原文仅保留在本页冲突面板，可复制或丢弃。');
          continue;
        }
        registry.open(
          binding.result.snapshot,
          binding.result.nextClientSeq,
          binding.descriptor,
        );
      }
    }).catch((error) => {
      if ((error as { name?: string })?.name === 'AbortError') return;
      setStatus(safeCollaborationTextBindingStatus(error));
    });
    return () => {
      controller.abort();
      const registry = textRegistryRef.current;
      for (const descriptor of descriptors) registry?.close(collaborationWorkspaceTextKey(descriptor));
    };
  }, [
    canEdit,
    addScopedTextConflict,
    canvasId,
    connectionState.phase,
    ensureTextRegistry,
    selectedNodeEntityUid,
    selectedNodeId,
    textBindingReload,
  ]);

  const openReviewCommentBody = useCallback(async (
    item: CollaborationReviewComment,
  ) => {
    if (!canComment
      || connectionStateRef.current.phase !== 'online'
      || !canvasId
      || !item.entityUid
      || String(item.createdBy || '').toLowerCase()
        !== String(sessionRef.current?.memberId || '').toLowerCase()) return;
    const descriptor: CollaborationWorkspaceTextDescriptor = {
      targetType: 'review',
      targetEntityUid: item.entityUid,
      field: 'body',
      displayId: item.id,
      label: `评论 ${item.id}`,
      authoritativeText: item.body,
    };
    const capturedSession = sessionRef.current;
    const capturedQueueScopeGeneration = queueScopeGenerationRef.current;
    const capturedRecoveryGeneration = normalizeCollaborationRecoveryGeneration(
      authoritativeGenerationRef.current,
    );
    if (!capturedSession || !capturedRecoveryGeneration) return;
    const loadLease = reviewTextLoadFenceRef.current!.begin();
    const isCurrentTextScope = () => {
      const activeSession = sessionRef.current;
      return loadLease.isCurrent()
        && connectionStateRef.current.phase === 'online'
        && capturedQueueScopeGeneration === queueScopeGenerationRef.current
        && capturedRecoveryGeneration === normalizeCollaborationRecoveryGeneration(
          authoritativeGenerationRef.current,
        )
        && Boolean(activeSession)
        && capturedSession.id === activeSession!.id
        && capturedSession.projectId === activeSession!.projectId
        && capturedSession.canvasId === activeSession!.canvasId
        && capturedSession.authorizationEpoch === activeSession!.authorizationEpoch
        && activeSession!.capabilities.includes('comment');
    };
    try {
      const binding = await loadCollaborationTextBinding(
        canvasId,
        capturedSession.projectId,
        descriptor,
        {
          signal: loadLease.signal,
          isCurrentScope: isCurrentTextScope,
          authoritativeText: descriptor.authoritativeText,
        },
      );
      if (!isCurrentTextScope()) return;
      if (editingReviewTextKey) {
        textRegistryRef.current?.close(editingReviewTextKey);
        setEditingReviewTextKey('');
      }
      if (binding.kind === 'recovery') {
        const conflict = collaborationTextLegacyRecoveryConflict(binding.recovery, descriptor);
        if (textDismissedRecoveryIdsRef.current.has(conflict.id)) return;
        addScopedTextConflict(
          conflict,
          collaborationTextRecoveryScopeKey(capturedSession),
        );
        setEditingReviewTextKey('');
        setStatus('检测到旧 schema 评论正文；原文仅保留在本页冲突面板，可复制或丢弃。');
        return;
      }
      const view = ensureTextRegistry().open(
        binding.snapshot,
        binding.nextClientSeq,
        descriptor,
      );
      setEditingReviewTextKey(view.key);
    } catch (error) {
      if ((error as { name?: string })?.name === 'AbortError') return;
      if (!isCurrentTextScope()) return;
      setStatus(safeCollaborationTextBindingStatus(error));
    } finally {
      loadLease.release();
    }
  }, [addScopedTextConflict, canComment, canvasId, editingReviewTextKey, ensureTextRegistry]);

  useEffect(() => {
    if (!editingReviewTextKey) return;
    const targetStillExists = reviews.some((thread) => thread.comments?.some((item) => (
      item.entityUid && collaborationWorkspaceTextKey({
        targetType: 'review',
        targetEntityUid: item.entityUid,
        field: 'body',
      }) === editingReviewTextKey
    )));
    const view = visibleTextViews[editingReviewTextKey];
    if (!view || !targetStillExists) {
      if (view && !targetStillExists) {
        textRegistryRef.current?.invalidateTarget('review', view.targetEntityUid, {
          code: 'collaboration_text_target_deleted',
        });
      } else {
        textRegistryRef.current?.close(editingReviewTextKey);
      }
      setEditingReviewTextKey('');
    }
  }, [editingReviewTextKey, reviews, visibleTextViews]);

  const closeReviewCommentBody = useCallback(() => {
    reviewTextLoadFenceRef.current?.cancel();
    if (editingReviewTextKey) textRegistryRef.current?.close(editingReviewTextKey);
    setEditingReviewTextKey('');
  }, [editingReviewTextKey]);

  const replaceCollaborativeText = useCallback((key: string, value: string) => {
    try {
      textRegistryRef.current?.replaceText(key, value);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }, []);

  const undoCollaborativeText = useCallback((key: string) => {
    try { textRegistryRef.current?.undo(key); } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }, []);

  const redoCollaborativeText = useCallback((key: string) => {
    try { textRegistryRef.current?.redo(key); } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }, []);

  const removeTextConflict = useCallback((item: CollaborationTextConflictItem) => {
    if (item.id.startsWith('legacy:')) textDismissedRecoveryIdsRef.current.add(item.id);
    const scope = textRecoveryScopeRef.current;
    setTextConflicts(textConflictVaultRef.current.discard(scope, item));
    if (!item.id.startsWith('legacy:') && connectionStateRef.current.phase === 'online') {
      textRegistryRef.current?.setOnline(true);
      setTextBindingReload((current) => current + 1);
    }
  }, []);

  const copyTextConflict = useCallback(async (
    item: CollaborationTextConflictItem,
    exactText: string,
  ) => {
    await copyCollaborationTextConflictToClipboardExact(item, exactText);
    removeTextConflict(item);
  }, [removeTextConflict]);

  const submitCollaborationRunOperation = useCallback(async (
    operation: CollaborationRunOperation,
    recovered = false,
  ) => {
    if (runIntentSubmittingKeysRef.current.has(operation.idempotencyKey)) return;
    runIntentSubmittingKeysRef.current.add(operation.idempotencyKey);
    let mutationFence: CollaborationMutationFence;
    try {
      mutationFence = captureMutationFence();
      const rawIntent = await collaborationMutationRequest<RunIntent>(
        mutationFence,
        '/api/collab/run-intents',
        {
          method: 'POST',
          body: JSON.stringify({
            canvasId: operation.canvasId,
            canvasRevision: operation.canvasRevision,
            nodeIds: operation.nodeIds,
            idempotencyKey: operation.idempotencyKey,
          }),
        },
      );
      assertMutationFenceCurrent(mutationFence);
      const activeSession = sessionRef.current;
      const intent = normalizeCollaborationRunIntentView(rawIntent, operation.canvasId);
      if (!activeSession
        || intent?.canvasId !== operation.canvasId
        || intent?.requestedBy !== operation.memberId
        || operation.projectId !== activeSession.projectId
        || operation.memberId !== activeSession.memberId) {
        throw new Error('主机返回的运行请求未通过当前成员作用域校验。');
      }
      completeCollaborationRunOperation(
        availableLocalStorage(),
        operation,
        operation.idempotencyKey,
      );
      if (runIntentRecoveryTimerRef.current !== null) {
        window.clearTimeout(runIntentRecoveryTimerRef.current);
        runIntentRecoveryTimerRef.current = null;
      }
      runIntentRecoveryAttemptedRef.current = '';
      setOwnRunIntents((current) => ({
        ...current,
        [intent.id]: mergeCollaborationRunIntentView(current[intent.id], intent),
      }));
      setStatus(recovered ? '已恢复并确认上次运行请求' : '运行请求已发送给画布所有者');
    } catch (error) {
      const definitive = isDefinitiveCollaborationOperationRejection(error);
      if (definitive) {
        completeCollaborationRunOperation(
          availableLocalStorage(),
          operation,
          operation.idempotencyKey,
        );
      } else if (recovered && runIntentRecoveryAttemptedRef.current === operation.idempotencyKey) {
        runIntentRecoveryAttemptedRef.current = '';
        if (runIntentRecoveryTimerRef.current !== null) {
          window.clearTimeout(runIntentRecoveryTimerRef.current);
        }
        runIntentRecoveryTimerRef.current = window.setTimeout(() => {
          runIntentRecoveryTimerRef.current = null;
          setRunIntentRecoveryRetry((current) => current + 1);
        }, 2_000);
      }
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      runIntentSubmittingKeysRef.current.delete(operation.idempotencyKey);
    }
  }, [
    assertMutationFenceCurrent,
    captureMutationFence,
    collaborationMutationRequest,
  ]);

  const requestRun = useCallback(() => {
    const activeSession = sessionRef.current;
    if (!canRun || !document || !activeSession) return;
    const storage = availableLocalStorage();
    if (!storage) {
      setStatus('浏览器无法保存运行请求身份；为避免重复生成，本次未提交。请允许本站本地存储后重试。');
      return;
    }
    try {
      const selected = nodes.filter((node) => node.selected).map((node) => node.id);
      const operation = beginCollaborationRunOperation(storage, {
        projectId: activeSession.projectId,
        canvasId: document.canvasId,
        memberId: activeSession.memberId,
      }, document.revision, selected);
      void submitCollaborationRunOperation(operation);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }, [canRun, document, nodes, submitCollaborationRunOperation]);

  useEffect(() => () => {
    if (runIntentRecoveryTimerRef.current !== null) {
      window.clearTimeout(runIntentRecoveryTimerRef.current);
      runIntentRecoveryTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    const activeSession = sessionRef.current;
    const recoveryGeneration = normalizeCollaborationRecoveryGeneration(
      authoritativeGenerationRef.current,
    );
    const scopeIdentity = activeSession
      ? [
        activeSession.projectId,
        activeSession.canvasId,
        activeSession.memberId,
        activeSession.id,
        activeSession.authorizationEpoch,
        recoveryGeneration,
      ].join(':')
      : '';
    if (runIntentRecoveryScopeRef.current !== scopeIdentity) {
      runIntentRecoveryScopeRef.current = scopeIdentity;
      runIntentRecoveryAttemptedRef.current = '';
    }
    if (!activeSession
      || !canRun
      || !document
      || document.canvasId !== activeSession.canvasId
      || connectionState.phase !== 'online'
      || !socketScopeReady
      || !scopeIdentity) return;
    const operation = readCollaborationRunOperation(availableLocalStorage(), {
      projectId: activeSession.projectId,
      canvasId: activeSession.canvasId,
      memberId: activeSession.memberId,
    });
    if (!operation || runIntentRecoveryAttemptedRef.current === operation.idempotencyKey) return;
    runIntentRecoveryAttemptedRef.current = operation.idempotencyKey;
    void submitCollaborationRunOperation(operation, true);
  }, [
    canRun,
    connectionState.phase,
    document,
    runIntentRecoveryRetry,
    session,
    socketScopeReady,
    submitCollaborationRunOperation,
  ]);

  const cancelOwnRunIntent = async (intent: CollaborationRunIntentView) => {
    const activeSession = sessionRef.current;
    if (!activeSession
      || intent.canvasId !== activeSession.canvasId
      || intent.requestedBy !== activeSession.memberId
      || !Number.isSafeInteger(intent.queueRevision)
      || Number(intent.queueRevision) < 1) {
      setStatus('运行请求缺少当前权威队列 revision，不能盲目取消。');
      return;
    }
    setRunIntentCancellingId(intent.id);
    try {
      const mutationFence = captureMutationFence();
      const raw = await collaborationMutationRequest<RunIntent>(
        mutationFence,
        `/api/collab/run-intents/${encodeURIComponent(intent.id)}/cancel`,
        {
          method: 'POST',
          body: JSON.stringify({ expectedQueueRevision: intent.queueRevision }),
        },
      );
      const cancelled = normalizeCollaborationRunIntentView(raw, activeSession.canvasId);
      if (!cancelled || cancelled.requestedBy !== activeSession.memberId || cancelled.id !== intent.id) {
        throw new Error('主机返回的取消结果未通过当前成员作用域校验。');
      }
      setOwnRunIntents((current) => ({
        ...current,
        [cancelled.id]: mergeCollaborationRunIntentView(current[cancelled.id], cancelled),
      }));
      setStatus(cancelled.cancelRequestedAt && !cancelled.cancelledAt
        ? '已请求取消，主机正在安全停止当前租约。'
        : '运行请求已取消。');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setRunIntentCancellingId('');
    }
  };

  const openSharedRunDetail = async (runId: string) => {
    setSelectedSharedRunId(runId);
    try {
      await loadSharedRunDetail(runId, { showLoading: true });
    } catch {
      // loadSharedRunDetail 已将安全错误写入本地面板。
    }
  };

  const refreshSharedRuns = async () => {
    const activeSession = sessionRef.current;
    if (!activeSession) return;
    setSharedRunError('');
    try {
      await initializeCollaborationRuns(activeSession);
      await syncCollaborationRuns(activeSession);
      if (selectedSharedRunId) {
        await loadSharedRunDetail(selectedSharedRunId, { showLoading: true });
      }
    } catch (error) {
      setSharedRunError(error instanceof Error ? error.message : String(error));
    }
  };

  const startSubflowPublication = (definition: SubflowDefinition) => {
    if (!currentRecoveryGeneration || !queueScopeReady) {
      setStatus('当前恢复代次尚未稳定，暂不能创建子工作流发布草稿。');
      return;
    }
    setSubflowDraft({
      definition: typeof structuredClone === 'function' ? structuredClone(definition) : JSON.parse(JSON.stringify(definition)),
      baseRevision: Math.max(1, Number(definition.revision || definition.version) || 1),
      recoveryGeneration: currentRecoveryGeneration,
      name: definition.name,
      description: definition.description || '',
      changeSummary: '',
    });
  };

  const publishSubflow = async () => {
    if (!canPublishSubflow || !subflowDraft?.name.trim() || !subflowDraft.changeSummary.trim()) return;
    if (!currentRecoveryGeneration
      || subflowDraft.recoveryGeneration !== currentRecoveryGeneration
      || !queueScopeReady) {
      setStatus('主机恢复代次已变化；旧代次子工作流草稿已保留，但不能发布到当前代次。');
      return;
    }
    setBusy(true);
    try {
      const mutationFence = captureMutationFence();
      const saved = await collaborationMutationRequest<SubflowDefinition>(mutationFence, `/api/collab/subflows/${encodeURIComponent(subflowDraft.definition.id)}/publish`, {
        method: 'POST',
        body: JSON.stringify({
          baseRevision: subflowDraft.baseRevision,
          changeSummary: subflowDraft.changeSummary.trim(),
          definition: {
            ...subflowDraft.definition,
            name: subflowDraft.name.trim(),
            description: subflowDraft.description.trim(),
          },
        }),
      });
      setSubflowDraft(null);
      await loadSubflows(() => {
        try {
          assertMutationFenceCurrent(mutationFence);
          return true;
        } catch {
          return false;
        }
      });
      assertMutationFenceCurrent(mutationFence);
      setStatus(`已发布 ${saved.name} v${saved.version} / revision ${saved.revision}`);
    } catch (error: any) {
      const current = error?.status === 409 ? error?.data?.data : null;
      if (current?.definition) {
        setSubflowDraft((draft) => draft ? {
          ...draft,
          conflict: {
            revision: Math.max(1, Number(current.revision) || 1),
            latestVersion: Math.max(1, Number(current.latestVersion) || 1),
            definition: current.definition as SubflowDefinition,
          },
        } : draft);
        setStatus(`发布冲突：服务器已到 v${current.latestVersion} / revision ${current.revision}，当前草稿未丢失`);
      } else setStatus(error instanceof Error ? error.message : String(error));
    } finally { setBusy(false); }
  };

  const loadLatestSubflowConflict = () => setSubflowDraft((draft) => {
    if (!draft?.conflict) return draft;
    const latest = draft.conflict.definition;
    return {
      definition: typeof structuredClone === 'function' ? structuredClone(latest) : JSON.parse(JSON.stringify(latest)),
      baseRevision: draft.conflict.revision,
      recoveryGeneration: draft.recoveryGeneration,
      name: latest.name,
      description: latest.description || '',
      changeSummary: '',
    };
  });

  const orderedSharedRuns = Object.values(sharedRuns)
    .sort((left, right) => right.updatedAt - left.updatedAt || right.createdAt - left.createdAt || left.id.localeCompare(right.id));
  const selectedSharedRun = selectedSharedRunId ? sharedRuns[selectedSharedRunId] || null : null;
  const orderedOwnRunIntents = Object.values(ownRunIntents)
    .sort((left, right) => right.updatedAt - left.updatedAt || right.createdAt - left.createdAt || left.id.localeCompare(right.id));
  const subflowDraftGenerationCurrent = Boolean(
    subflowDraft
    && currentRecoveryGeneration
    && subflowDraft.recoveryGeneration === currentRecoveryGeneration
    && queueScopeReady,
  );

  return (
    <div
      className="flex h-screen flex-col bg-[var(--bg-primary)] text-[var(--text-primary)]"
      onPointerCancel={() => { finalizeLocalDrag(); }}
      onPointerMove={(event) => {
      const nextPresence = {
        ...localPresenceRef.current,
        cursor: { x: event.clientX, y: event.clientY },
        selectedNodeIds: nodes.filter((node) => node.selected).map((node) => node.id).slice(0, 100),
      };
      localPresenceRef.current = nextPresence;
      if (localDragRef.current && !localDragRef.current.finalCommitted) return;
      if (connectionStateRef.current.phase !== 'online'
        || webSocketRef.current?.readyState !== WebSocket.OPEN
        || Date.now() - pointerSentAtRef.current < 100) return;
      pointerSentAtRef.current = Date.now();
      webSocketRef.current.send(JSON.stringify({ type: 'presence.update', presence: nextPresence }));
    }}>
      <header className="flex min-h-14 shrink-0 flex-wrap items-center gap-2 border-b border-[var(--border-primary)] bg-[var(--bg-secondary)] px-3 py-2 md:h-14 md:flex-nowrap md:gap-3 md:px-4 md:py-0">
        <Shield size={19} className="text-[var(--accent-primary)]" /><div className="min-w-0 flex-1"><h1 className="text-sm font-bold">T8 协作画布</h1><p className="truncate text-[10px] text-[var(--text-secondary)]">{status}</p></div>
        <div data-testid="collaboration-scoped-canvas" className="order-3 h-9 min-w-0 flex-1 truncate rounded border border-[var(--border-primary)] bg-[var(--bg-primary)] px-3 py-2 text-xs md:order-none md:max-w-56 md:flex-none" title={canvases[0]?.name || session?.canvasId || ''}>{canvases[0]?.name || session?.canvasId || '等待画布授权'}</div>
        <button type="button" className="grid h-9 w-9 place-items-center rounded border border-[var(--border-primary)] disabled:opacity-40" title="通过单飞同步恢复权威画布" disabled={!session?.canvasId || busy} onClick={() => void manualRecoverCanvas()}><RefreshCw size={15} /></button>
        {canRun && <button type="button" className="flex h-9 items-center gap-2 rounded bg-[var(--accent-primary)] px-3 text-xs font-bold text-white" onClick={requestRun}><Play size={14} />请求运行</button>}
        <div className="flex min-w-0 max-w-44 items-center gap-2 text-xs"><CircleUserRound size={16} className="shrink-0" /><span className="truncate">{session?.displayName || displayName}</span><span className="shrink-0 opacity-55">{session?.role}</span></div>
        {session && (
          <div className="flex shrink-0 items-center gap-1" data-testid="collaboration-participant-session-actions">
            <button
              type="button"
              data-testid="collaboration-participant-session-rotate"
              className={`flex h-8 items-center gap-1 rounded border px-2 text-[10px] font-bold disabled:opacity-40 ${participantSessionConfirmation === 'rotate' ? 'border-amber-500 bg-amber-500/10 text-amber-600' : 'border-[var(--border-primary)]'}`}
              title={queueStats.operations > 0 ? '请先等待未提交操作保存完成' : '撤销旧凭据并轮换当前协作会话'}
              disabled={busy || Boolean(participantSessionAction) || structureBusy || saveState.phase === 'saving' || queueStats.operations > 0}
              onClick={() => void rotateParticipantSession()}
            >
              {participantSessionAction === 'rotate' ? <Loader2 size={11} className="animate-spin" /> : <RotateCcw size={11} />}
              {participantSessionAction === 'rotate' ? '轮换中' : participantSessionConfirmation === 'rotate' ? '确认轮换' : '轮换会话'}
            </button>
            <button
              type="button"
              data-testid="collaboration-participant-session-logout"
              className={`flex h-8 items-center gap-1 rounded border px-2 text-[10px] font-bold disabled:opacity-40 ${participantSessionConfirmation === 'logout' ? 'border-red-500 bg-red-500/10 text-red-500' : 'border-[var(--border-primary)]'}`}
              title="撤销并退出当前参与者会话"
              disabled={busy || Boolean(participantSessionAction)}
              onClick={() => void logoutParticipantSession()}
            >
              {participantSessionAction === 'logout' ? <Loader2 size={11} className="animate-spin" /> : <LogOut size={11} />}
              {participantSessionAction === 'logout' ? '退出中' : participantSessionConfirmation === 'logout' ? '确认退出' : '退出协作'}
            </button>
            {participantSessionConfirmation && !participantSessionAction && (
              <button
                type="button"
                className="grid h-8 w-8 place-items-center rounded border border-[var(--border-primary)]"
                aria-label="取消会话操作"
                onClick={() => {
                  setParticipantSessionConfirmation(null);
                  setStatus('已取消会话操作。');
                }}
              ><X size={11} /></button>
            )}
          </div>
        )}
      </header>
      {session && (
        <div
          className={`shrink-0 border-b px-4 py-2 text-xs ${canEdit ? 'border-green-500/30 bg-green-500/10' : 'border-amber-500/30 bg-amber-500/10'}`}
          data-testid="collaboration-access-mode"
        >
          <strong>{canEdit ? '编辑连接' : session.role === 'reviewer' ? '审阅连接 · 画布只读' : '查看连接 · 完全只读'}</strong>
          <span className="ml-2 text-[var(--text-secondary)]">
            {canEdit
              ? '可按主机授予的能力编辑、上传或请求运行。'
              : session.role === 'reviewer'
                ? '可以评论和审批，不能拖动、删除、连线、运行、上传或发布。'
                : '只能查看画布与获授权素材，不能修改或发起运行。'}
          </span>
        </div>
      )}
      <div
        data-testid="collaboration-connection-state"
        data-phase={connectionState.phase}
        className={`flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b px-4 py-2 text-xs ${connectionState.phase === 'online' ? 'border-green-500/30 bg-green-500/10' : connectionState.phase === 'blocked' || connectionState.phase === 'revoked' ? 'border-red-500/30 bg-red-500/10' : 'border-amber-500/30 bg-amber-500/10'}`}
      >
        <strong>{connectionState.phase === 'online' ? '协作在线' : `连接状态：${connectionState.phase}`}</strong>
        <span className="min-w-0 flex-1 text-[var(--text-secondary)]">{connectionState.message}</span>
        {connectionState.attempt > 0 && <span className="opacity-60">第 {connectionState.attempt} 次重连</span>}
        {['offline', 'reconnecting', 'host-stopped'].includes(connectionState.phase) && (
          <button type="button" className="h-7 rounded border border-[var(--border-primary)] px-2 text-[10px] font-bold" onClick={() => retryConnectionRef.current?.()}>立即重连</button>
        )}
      </div>
      {session && (canEdit || queueStats.operations > 0) && (
        <div
          data-testid="collaboration-save-state"
          data-phase={saveState.phase}
          className={`flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b px-4 py-2 text-xs ${saveState.phase === 'blocked' ? 'border-red-500/30 bg-red-500/10' : saveState.phase === 'saved' ? 'border-green-500/30 bg-green-500/10' : 'border-amber-500/30 bg-amber-500/10'}`}
        >
          <strong>{saveState.phase === 'saved' ? '已保存' : saveState.phase === 'saving' ? '正在保存' : saveState.phase === 'blocked' ? '需要处理' : '待提交'}</strong>
          <span className="min-w-0 flex-1 text-[var(--text-secondary)]">{saveState.message}</span>
          <span className="opacity-60">{queueStats.operations}/200 条 · {(queueStats.bytes / 1024).toFixed(1)}/256 KiB · blocked {queueStats.blocked}</span>
          {failedQueueTransitionRef.current?.scopeGeneration === queueScopeGenerationRef.current && (
            <button type="button" className="h-7 rounded border border-[var(--border-primary)] px-2 text-[10px] font-bold" onClick={() => void retryFailedQueuePersistence()}>重试本地保存</button>
          )}
        </div>
      )}
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <main className="relative min-w-0 flex-1">
          {busy && <div className="absolute inset-0 z-20 grid place-items-center bg-black/15"><Loader2 size={26} className="animate-spin" /></div>}
          {canEdit && (
            <div data-testid="collaboration-structure-toolbar" className="absolute left-3 top-3 z-10 flex flex-wrap gap-2 rounded border border-[var(--border-primary)] bg-[var(--bg-secondary)]/95 p-2 shadow-lg">
              <button type="button" className="flex h-8 items-center gap-1 rounded border border-[var(--border-primary)] px-2 text-[10px] font-bold disabled:opacity-40" disabled={structureBusy} onClick={addTextNode}><Plus size={12} />文本节点</button>
              <button type="button" data-testid="collaboration-text-title-prompt" className="flex h-8 items-center gap-1 rounded border border-[var(--border-primary)] px-2 text-[10px] font-bold disabled:opacity-40" disabled={structureBusy || connectionState.phase !== 'online' || !nodes.some((node) => String(node.id) === selectedNodeId)} onClick={renameSelectedNode}><RotateCcw size={12} />改标题</button>
              <button type="button" className="flex h-8 items-center gap-1 rounded border border-red-500/40 px-2 text-[10px] font-bold text-red-500 disabled:opacity-40" disabled={structureBusy || (!nodes.some((node) => node.selected) && !edges.some((edge) => edge.selected))} onClick={deleteSelectedElements}><Trash2 size={12} />删除选中</button>
              {structureBusy && <span className="flex items-center gap-1 px-1 text-[10px] opacity-60"><Loader2 size={11} className="animate-spin" />等待主机确认</span>}
            </div>
          )}
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={COLLABORATION_NODE_TYPES}
            nodesDraggable={canEdit}
            nodesConnectable={canEdit}
            deleteKeyCode={canEdit ? ['Backspace', 'Delete'] : null}
            elementsSelectable
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onNodeDragStart={beginLocalDrag}
            onNodeDrag={previewLocalDrag}
            onNodeDragStop={onNodeDragStop}
            onConnect={connectNodes}
            onDelete={deleteElements}
            isValidConnection={validateConnection}
            onNodeClick={(_event, node) => setSelectedNodeId(node.id)}
            fitView
            minZoom={0.05}
            maxZoom={2}
          ><Background /><Controls /><MiniMap pannable zoomable /></ReactFlow>
          {Object.values(presence).map((member) => member.cursor && <div key={collaborationPresenceKey(member.memberId, member.connectionId)} className="pointer-events-none fixed z-30 rounded bg-[var(--accent-primary)] px-2 py-1 text-[10px] font-bold text-white" style={{ left: member.cursor.x + 8, top: member.cursor.y + 8 }}>{member.displayName}</div>)}
        </main>
        <aside className="h-[45vh] w-full shrink-0 overflow-auto border-t border-[var(--border-primary)] bg-[var(--bg-secondary)] p-4 md:h-auto md:w-[28rem] md:border-l md:border-t-0">
          <div className="mb-4 flex items-center gap-2"><Users size={16} /><h2 className="text-sm font-bold">协作与审阅</h2><span className="ml-auto text-[10px] opacity-55">{Object.keys(presence).length + (connectionState.phase === 'online' ? 1 : 0)} 在线</span></div>
          <div className="mb-5 text-xs leading-5 text-[var(--text-secondary)]">{selectedNodeId ? `当前节点：${selectedNodeId}` : '点击节点后可留下锚定评论。'}</div>
          {canEdit && selectedNodeEntityUid && (
            <section data-testid="collaboration-text-node-editor" className="mb-5 rounded border border-[var(--border-primary)] p-3">
              <h3 className="text-xs font-bold">实时文本字段</h3>
              <p className="mt-1 text-[10px] leading-4 text-[var(--text-secondary)]">仅在线提交；断线不会进入移动操作的 sessionStorage 队列。</p>
              <label className="mt-3 block text-[10px] font-semibold">
                标题
                <input
                  data-testid="collaboration-text-node-title"
                  value={selectedNodeTitleView?.text || ''}
                  maxLength={512}
                  disabled={connectionState.phase !== 'online' || !selectedNodeTitleView}
                  className="mt-1 h-8 w-full rounded border border-[var(--border-primary)] bg-[var(--bg-primary)] px-2 text-xs disabled:opacity-50"
                  onChange={(event) => replaceCollaborativeText(selectedNodeTitleKey, event.target.value)}
                />
              </label>
              <div className="mt-2 flex gap-2">
                <button type="button" data-testid="collaboration-text-title-undo" className="h-7 flex-1 rounded border border-[var(--border-primary)] text-[10px] font-bold disabled:opacity-40" disabled={connectionState.phase !== 'online' || !selectedNodeTitleView?.canUndo} onClick={() => undoCollaborativeText(selectedNodeTitleKey)}>撤销</button>
                <button type="button" data-testid="collaboration-text-title-redo" className="h-7 flex-1 rounded border border-[var(--border-primary)] text-[10px] font-bold disabled:opacity-40" disabled={connectionState.phase !== 'online' || !selectedNodeTitleView?.canRedo} onClick={() => redoCollaborativeText(selectedNodeTitleKey)}>重做</button>
              </div>
              <label className="mt-3 block text-[10px] font-semibold">
                Prompt
                <textarea
                  data-testid="collaboration-text-node-prompt"
                  value={selectedNodePromptView?.text || ''}
                  maxLength={200000}
                  rows={5}
                  disabled={connectionState.phase !== 'online' || !selectedNodePromptView}
                  className="mt-1 w-full resize-y rounded border border-[var(--border-primary)] bg-[var(--bg-primary)] p-2 text-xs disabled:opacity-50"
                  onChange={(event) => replaceCollaborativeText(selectedNodePromptKey, event.target.value)}
                />
              </label>
              <div className="mt-2 flex gap-2">
                <button type="button" data-testid="collaboration-text-prompt-undo" className="h-7 flex-1 rounded border border-[var(--border-primary)] text-[10px] font-bold disabled:opacity-40" disabled={connectionState.phase !== 'online' || !selectedNodePromptView?.canUndo} onClick={() => undoCollaborativeText(selectedNodePromptKey)}>撤销</button>
                <button type="button" data-testid="collaboration-text-prompt-redo" className="h-7 flex-1 rounded border border-[var(--border-primary)] text-[10px] font-bold disabled:opacity-40" disabled={connectionState.phase !== 'online' || !selectedNodePromptView?.canRedo} onClick={() => redoCollaborativeText(selectedNodePromptKey)}>重做</button>
              </div>
            </section>
          )}
          {visibleTextConflicts.length > 0 && (
            <CollaborationConflictPanel
              className="mb-5"
              items={visibleTextConflicts}
              onCopyText={copyTextConflict}
              onDiscardText={removeTextConflict}
              onResyncStructure={() => manualRecoverCanvas()}
              onExplicitRestoreStructure={async () => {
                throw new Error('文本冲突不允许自动恢复已删除或已换 epoch 的对象。');
              }}
              onActionError={(error) => setStatus(error instanceof Error ? error.message : String(error))}
            />
          )}
          {canEdit && document && (Object.keys(document.tombstones.nodes).length > 0 || Object.keys(document.tombstones.edges).length > 0) && (
            <section data-testid="collaboration-tombstones" className="mb-5 rounded border border-[var(--border-primary)] p-3">
              <h3 className="flex items-center gap-2 text-xs font-bold"><RotateCcw size={13} />显式恢复</h3>
              <p className="mt-1 text-[10px] leading-4 text-[var(--text-secondary)]">删除优先于陈旧编辑；只有绑定原 tombstone 身份的恢复事务可以重新创建对象。</p>
              <div className="mt-3 space-y-2">
                {Object.entries(document.tombstones.nodes).slice(0, 20).map(([nodeId, tombstone]) => (
                  <button key={`node:${nodeId}`} type="button" className="flex h-8 w-full items-center justify-between gap-2 rounded border border-[var(--border-primary)] px-2 text-[10px] disabled:opacity-40" disabled={structureBusy} onClick={() => restoreDeletedNode(nodeId)}><span className="truncate">节点 {nodeId}</span><span className="shrink-0 opacity-55">{tombstone.entityType || 'unknown'}</span></button>
                ))}
                {Object.entries(document.tombstones.edges).slice(0, 20).map(([edgeId, tombstone]) => (
                  <button key={`edge:${edgeId}`} type="button" className="flex h-8 w-full items-center justify-between gap-2 rounded border border-[var(--border-primary)] px-2 text-[10px] disabled:opacity-40" disabled={structureBusy} onClick={() => restoreDeletedEdge(edgeId)}><span className="truncate">连线 {edgeId}</span><span className="shrink-0 opacity-55">{tombstone.source}→{tombstone.target}</span></button>
                ))}
              </div>
            </section>
          )}
          {offlineQueue.some((item) => item.status === 'blocked') && (
            <section data-testid="collaboration-blocked-queue" className="mb-5 rounded border border-red-500/40 bg-red-500/10 p-3">
              <h3 className="text-xs font-bold">未提交操作需要处理</h3>
              <p className="mt-1 text-[10px] leading-4 text-[var(--text-secondary)]">自动重放严格按 FIFO 停在第一条 blocked 操作；重试会先同步，丢弃会恢复主机确认位置。</p>
              <div className="mt-3 space-y-2">
                {offlineQueue.filter((item) => item.status === 'blocked').map((item) => (
                  <article key={item.id} className="rounded border border-red-500/30 bg-[var(--bg-secondary)] p-2 text-[10px]">
                    <div className="truncate font-bold">节点 {item.operation.payload.nodeId}</div>
                    <div className="mt-1 break-words text-[var(--text-secondary)]">{item.error || '操作已冻结'}</div>
                    <div className="mt-2 flex gap-2">
                      <button type="button" className="h-7 flex-1 rounded border border-[var(--border-primary)] font-bold disabled:opacity-40" disabled={!canEdit || busy} onClick={() => void retryBlockedQueueItem(item.id)}>重试</button>
                      <button type="button" className="h-7 flex-1 rounded border border-red-500/50 font-bold text-red-500" onClick={() => discardQueueItem(item.id)}>丢弃</button>
                    </div>
                  </article>
                ))}
              </div>
            </section>
          )}
          {canUploadAsset && <CollaborationAssetUpload online={connectionState.phase === 'online'} scopeKey={`${session?.id || ''}\u0001${session?.projectId || ''}\u0001${session?.canvasId || ''}\u0001${session?.authorizationEpoch || 0}`} recoveryGeneration={authoritativeGenerationRef.current} onStatus={(message) => setStatus(message)} />}
          <section className="mb-5 border-y border-[var(--border-primary)] py-4" data-testid="collaboration-shared-run-center">
            <div className="mb-3 flex items-center gap-2">
              <Play size={15} />
              <div className="min-w-0 flex-1"><h3 className="text-xs font-bold">主机权威运行</h3><p className="text-[9px] text-[var(--text-secondary)]">快照 + RunEvent cursor {sharedRunCursor}；详情只展示服务端公开白名单。</p></div>
              <span className="text-[10px] opacity-55">{orderedSharedRuns.length}</span>
              <button type="button" title="增量同步运行状态" className="grid h-7 w-7 place-items-center rounded border border-[var(--border-primary)] disabled:opacity-40" disabled={!session || Boolean(sharedRunDetailLoadingId)} onClick={() => void refreshSharedRuns()}><RefreshCw size={11} /></button>
            </div>
            {sharedRunError && <p role="alert" className="mb-2 rounded border border-amber-500/50 bg-amber-500/10 p-2 text-[9px] leading-4 text-amber-600">{sharedRunError}</p>}
            {orderedOwnRunIntents.length > 0 && (
              <div className="mb-3 space-y-2" data-testid="collaboration-own-run-intents">
                <div className="text-[10px] font-bold">我的运行请求</div>
                {orderedOwnRunIntents.slice(0, 10).map((intent) => {
                  const cancellable = ['pending', 'accepted', 'dispatching', 'running'].includes(intent.status)
                    && !intent.cancelledAt;
                  return <article key={intent.id} className="rounded border border-[var(--border-primary)] bg-[var(--bg-primary)] p-2 text-[9px]">
                    <div className="flex items-center gap-2"><strong className="min-w-0 flex-1 truncate">Intent {intent.id.slice(0, 12)}</strong><span>{intent.status}</span></div>
                    <div className="mt-1 text-[var(--text-secondary)]">queue r{intent.queueRevision ?? '?'} · 画布 r{intent.canvasRevision} · {intent.nodeIds.length || '全部'} 节点</div>
                    {intent.cancelRequestedAt && !intent.cancelledAt && <p className="mt-1 text-amber-600">已请求取消，等待主机安全释放当前执行租约。</p>}
                    {intent.lastError?.message && <p className="mt-1 break-words text-red-500">{intent.lastError.code ? `${intent.lastError.code} · ` : ''}{intent.lastError.message}</p>}
                    {cancellable && <button type="button" className="mt-2 h-7 w-full rounded border border-red-500/50 font-bold text-red-500 disabled:opacity-40" disabled={Boolean(runIntentCancellingId) || Boolean(intent.cancelRequestedAt) || !Number.isSafeInteger(intent.queueRevision)} onClick={() => void cancelOwnRunIntent(intent)}>{runIntentCancellingId === intent.id ? '正在提交取消…' : '取消运行请求'}</button>}
                  </article>;
                })}
              </div>
            )}
            <div className="space-y-2">
              {orderedSharedRuns.slice(0, 20).map((run) => {
                const progress = collaborationRunProgress(run);
                return <article key={run.id} className={`rounded border p-2 ${selectedSharedRunId === run.id ? 'border-[var(--accent-primary)]' : 'border-[var(--border-primary)]'}`}>
                  <div className="flex items-center justify-between gap-2"><span className="truncate text-[10px] font-bold">Run {run.id.slice(0, 12)}</span><span className="shrink-0 text-[10px]">{run.status}</span></div>
                  <div className="mt-1 flex items-center justify-between gap-2 text-[9px] opacity-55"><span>r{run.canvasRevision} · {progress.terminal}/{progress.total} 节点 · {run.assets.length} 产物</span><span>{progress.percent}%</span></div>
                  <div className="mt-1 h-1 overflow-hidden rounded bg-black/10"><div className="h-full rounded bg-[var(--accent-primary)] transition-[width]" style={{ width: `${progress.percent}%` }} /></div>
                  <div className="mt-1 text-[9px] text-[var(--text-secondary)]">发起 {run.initiatorId} · {formatCollaborationRunTime(run.startedAt || run.createdAt)}</div>
                  {run.assets.length > 0 && <div className="mt-2 flex flex-wrap gap-1">{run.assets.map((asset) => asset.mediaUrl ? <a key={asset.id} href={asset.mediaUrl} target="_blank" rel="noreferrer" className="max-w-full truncate rounded border border-[var(--border-primary)] px-2 py-1 text-[9px] text-[var(--accent-primary)]">{asset.filename}</a> : <span key={asset.id} title="当前权限仅允许查看素材记录" className="max-w-full truncate rounded border border-[var(--border-primary)] px-2 py-1 text-[9px] opacity-55">{asset.filename}</span>)}</div>}
                  <button type="button" className="mt-2 h-7 w-full rounded border border-[var(--border-primary)] text-[9px] font-bold disabled:opacity-40" disabled={sharedRunDetailLoadingId === run.id} onClick={() => selectedSharedRunId === run.id ? setSelectedSharedRunId('') : void openSharedRunDetail(run.id)}>{sharedRunDetailLoadingId === run.id ? '读取 Run/NodeRun/Attempt…' : selectedSharedRunId === run.id ? '收起详情' : '查看 Run/NodeRun/Attempt'}</button>
                </article>;
              })}
              {!orderedSharedRuns.length && <div className="py-3 text-center text-[10px] opacity-55">暂无主机运行快照；连接恢复时会按事件游标增量补偿。</div>}
            </div>
            {selectedSharedRun && (
              <div className="mt-3 rounded border border-[var(--accent-primary)]/40 bg-[var(--bg-primary)] p-2" data-testid="collaboration-shared-run-detail">
                <div className="flex items-center gap-2 text-[10px] font-bold"><span className="min-w-0 flex-1 truncate">Run {selectedSharedRun.id}</span><button type="button" className="grid h-6 w-6 place-items-center" aria-label="关闭运行详情" onClick={() => setSelectedSharedRunId('')}><X size={10} /></button></div>
                <div className="mt-1 text-[9px] text-[var(--text-secondary)]">{selectedSharedRun.status} · 开始 {formatCollaborationRunTime(selectedSharedRun.startedAt)} · 完成 {formatCollaborationRunTime(selectedSharedRun.finishedAt)}</div>
                <div className="mt-2 max-h-80 space-y-2 overflow-auto">
                  {selectedSharedRun.nodes.map((node) => <details key={node.id} className="rounded border border-[var(--border-primary)] p-2 text-[9px]">
                    <summary className="cursor-pointer font-bold">NodeRun {node.id.slice(0, 12)} · 节点 {node.nodeId} · {node.status}{node.progressPercent != null ? ` · ${Math.round(node.progressPercent)}%` : ''}</summary>
                    <div className="mt-2 text-[var(--text-secondary)]">产物引用 {node.outputRefs.length} · 更新 {formatCollaborationRunTime(node.updatedAt)}</div>
                    <div className="mt-2 space-y-2">
                      {(node.attempts || []).map((attempt) => <article key={attempt.id} className="rounded bg-black/5 p-2">
                        <div className="flex items-center gap-2"><strong className="min-w-0 flex-1 truncate">Attempt {attempt.id.slice(0, 12)}</strong><span>{attempt.status}</span></div>
                        <div className="mt-1 text-[var(--text-secondary)]">轮询 {attempt.pollCount}{attempt.httpStatus ? ` · HTTP ${attempt.httpStatus}` : ''}{attempt.provider ? ` · ${attempt.provider}` : ''}{attempt.model ? ` / ${attempt.model}` : ''}</div>
                        {collaborationRunUsageEntries(attempt.usage).length > 0 && <dl className="mt-2 grid grid-cols-2 gap-x-2 gap-y-1">{collaborationRunUsageEntries(attempt.usage).map(([label, value]) => <div key={label} className="contents"><dt className="text-[var(--text-secondary)]">{label}</dt><dd className="text-right">{value}</dd></div>)}</dl>}
                        {attempt.error && <div role="alert" className="mt-2 rounded border border-red-500/40 bg-red-500/10 p-2 text-red-500"><div className="font-bold">{attempt.error.kind || 'unknown'}{attempt.error.code ? ` · ${attempt.error.code}` : ''}{attempt.error.retryable === true ? ' · 可重试' : ''}</div><p className="mt-1 break-words">{attempt.error.message}</p></div>}
                      </article>)}
                      {node.attempts && !node.attempts.length && <p className="text-[var(--text-secondary)]">该 NodeRun 暂无公开 Attempt。</p>}
                      {!node.attempts && <p className="text-[var(--text-secondary)]">展开详情后仍未收到 Attempt；可刷新重试。</p>}
                    </div>
                  </details>)}
                  {!selectedSharedRun.nodes.length && <p className="py-3 text-center text-[9px] text-[var(--text-secondary)]">该 Run 尚无 NodeRun。</p>}
                </div>
              </div>
            )}
          </section>
          <section className="mb-5 border-y border-[var(--border-primary)] py-4">
            <div className="mb-3 flex items-center gap-2"><GitFork size={15} /><h3 className="text-xs font-bold">子工作流版本</h3><span className="ml-auto text-[10px] opacity-55">{subflows.length}</span></div>
            <div className="space-y-2">{subflows.map((definition) => <article key={`${definition.id}-${definition.version}`} className="rounded border border-[var(--border-primary)] p-2"><div className="flex items-start gap-2"><div className="min-w-0 flex-1"><div className="truncate text-xs font-bold">{definition.name}</div><div className="mt-1 text-[9px] opacity-55">v{definition.version} · revision {definition.revision || definition.version}</div>{definition.changeSummary && <div className="mt-1 line-clamp-2 text-[10px] text-[var(--text-secondary)]">{definition.changeSummary}</div>}</div>{canPublishSubflow && <button type="button" className="h-8 shrink-0 rounded border border-[var(--border-primary)] px-2 text-[10px] font-bold" onClick={() => startSubflowPublication(definition)}>编辑新版本</button>}</div></article>)}{!subflows.length && <div className="py-3 text-center text-[10px] opacity-55">项目暂无子工作流</div>}</div>
            {subflowDraft && (
              <div className="mt-3 rounded border border-[var(--accent-primary)]/50 bg-[var(--bg-primary)] p-3">
                <div className="mb-2 flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-xs font-bold">基于 revision {subflowDraft.baseRevision}</span>
                  <button type="button" className="grid h-7 w-7 place-items-center rounded border border-[var(--border-primary)]" aria-label="关闭子工作流草稿" onClick={() => setSubflowDraft(null)}><X size={13} /></button>
                </div>
                <label className="block text-[10px] font-semibold">
                  名称
                  <input value={subflowDraft.name} maxLength={100} className="mt-1 h-8 w-full rounded border border-[var(--border-primary)] bg-[var(--bg-secondary)] px-2 text-xs" onChange={(event) => setSubflowDraft((draft) => draft ? { ...draft, name: event.target.value } : draft)} />
                </label>
                <label className="mt-2 block text-[10px] font-semibold">
                  说明
                  <textarea value={subflowDraft.description} maxLength={2000} rows={2} className="mt-1 w-full resize-y rounded border border-[var(--border-primary)] bg-[var(--bg-secondary)] p-2 text-xs" onChange={(event) => setSubflowDraft((draft) => draft ? { ...draft, description: event.target.value } : draft)} />
                </label>
                <label className="mt-2 block text-[10px] font-semibold">
                  变更说明（必填）
                  <textarea value={subflowDraft.changeSummary} maxLength={500} rows={2} className="mt-1 w-full resize-y rounded border border-[var(--border-primary)] bg-[var(--bg-secondary)] p-2 text-xs" onChange={(event) => setSubflowDraft((draft) => draft ? { ...draft, changeSummary: event.target.value } : draft)} />
                </label>
                {subflowDraft.conflict && (
                  <div role="alert" className="mt-2 rounded border border-amber-500/50 bg-amber-500/10 p-2 text-[10px] leading-4 text-amber-600">
                    服务器已到 v{subflowDraft.conflict.latestVersion} / revision {subflowDraft.conflict.revision}，草稿未覆盖他人版本。
                    <button type="button" className="mt-2 h-7 w-full rounded border border-amber-500/50 font-bold" onClick={loadLatestSubflowConflict}>放弃草稿并载入最新版本</button>
                  </div>
                )}
                {!subflowDraftGenerationCurrent && (
                  <div role="alert" className="mt-2 rounded border border-amber-500/50 bg-amber-500/10 p-2 text-[10px] leading-4 text-amber-600">
                    主机恢复代次已变化。此草稿仍保留供人工复制，但不会发布到新的 revision namespace。
                  </div>
                )}
                <button type="button" className="mt-3 flex h-9 w-full items-center justify-center gap-2 rounded bg-[var(--accent-primary)] text-xs font-bold text-white disabled:opacity-40" disabled={busy || !subflowDraftGenerationCurrent || !subflowDraft.name.trim() || !subflowDraft.changeSummary.trim()} onClick={() => void publishSubflow()}><Upload size={13} />发布不可变新版本</button>
              </div>
            )}
          </section>
          {session && document && queueScopeReady && (
            <CollaborationReviewPanel
              key={`${session.id}\u0001${session.authorizationEpoch}\u0001${currentRecoveryGeneration}\u0001${queueScopeVersion}`}
              canvasId={canvasId}
              canvasRevision={document.revision}
              memberId={session.memberId}
              online={connectionState.phase === 'online'}
              canComment={canComment}
              canApprove={canApprove}
              nodes={nodes as Array<Node & { entityUid?: string }>}
              edges={edges as Array<Edge & { entityUid?: string }>}
              selectedNodeId={selectedNodeId}
              selectedEdgeId={selectedEdgeId}
              threads={reviews}
              refreshToken={reviewRefreshToken}
              request={scopedCollaborationReviewRequest}
              onThreadsChange={setReviews}
              onStatus={setStatus}
              onSelectNode={setSelectedNodeId}
              textEditor={editingReviewTextView ? {
                entityUid: editingReviewTextView.targetEntityUid,
                text: editingReviewTextView.text,
                canUndo: editingReviewTextView.canUndo,
                canRedo: editingReviewTextView.canRedo,
              } : null}
              onOpenCommentEditor={openReviewCommentBody}
              onCloseCommentEditor={closeReviewCommentBody}
              onChangeCommentEditor={(value) => {
                if (editingReviewTextKey) replaceCollaborativeText(editingReviewTextKey, value);
              }}
              onUndoCommentEditor={() => {
                if (editingReviewTextKey) undoCollaborativeText(editingReviewTextKey);
              }}
              onRedoCommentEditor={() => {
                if (editingReviewTextKey) redoCollaborativeText(editingReviewTextKey);
              }}
            />
          )}
        </aside>
      </div>
    </div>
  );
}

export default function CollaborationWorkspace() {
  return <ReactFlowProvider><Workspace /></ReactFlowProvider>;
}
