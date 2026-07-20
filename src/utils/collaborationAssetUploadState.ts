export type CollaborationAssetUploadErrorKind =
  | 'quota'
  | 'conflict'
  | 'permission'
  | 'storage'
  | 'general';

export type CollaborationAssetUploadConnectivityAction =
  | 'continue'
  | 'suspend'
  | 'resume'
  | 'scope-conflict';

export interface CollaborationAssetUploadRecoverySessionIdentity {
  sessionId?: unknown;
  filename?: unknown;
  expectedSize?: unknown;
  expectedHash?: unknown;
  chunkSize?: unknown;
}

export interface CollaborationAssetUploadRecoveryFileIdentity {
  name: unknown;
  size: unknown;
  contentHash?: unknown;
}

export type CollaborationAssetUploadRecoveryBinding =
  | { ok: true }
  | {
      ok: false;
      code:
        | 'asset_upload_recovery_session_mismatch'
        | 'asset_upload_recovery_metadata_invalid'
        | 'asset_upload_recovery_filename_mismatch'
        | 'asset_upload_recovery_size_mismatch'
        | 'asset_upload_recovery_hash_missing'
        | 'asset_upload_recovery_hash_mismatch';
      message: string;
    };

const TERMINAL_UPLOAD_PHASES = new Set(['cancelled', 'completed', 'scope-conflict']);
const MANUALLY_HELD_UPLOAD_PHASES = new Set(['paused', 'error']);

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

const RECOVERY_SHA256_PATTERN = /^[a-f0-9]{64}$/;

function normalizedRecoveryFilename(value: unknown): string {
  const basename = String(value || '').split(/[\\/]/).pop() || '';
  return basename.normalize('NFKC').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 300);
}

function normalizedRecoveryHash(value: unknown): string {
  const hash = String(value || '').trim().toLowerCase();
  return RECOVERY_SHA256_PATTERN.test(hash) ? hash : '';
}

function positiveSafeInteger(value: unknown): number | null {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

/**
 * Cheap metadata-only match used before reading a browser File. The full SHA-256
 * binding below remains mandatory before any recovered server session is resumed.
 */
export function collaborationAssetUploadRecoveryMetadataMatches(
  session: CollaborationAssetUploadRecoverySessionIdentity,
  file: CollaborationAssetUploadRecoveryFileIdentity,
): boolean {
  return Boolean(
    String(session.sessionId || '')
    && normalizedRecoveryFilename(session.filename)
    && normalizedRecoveryFilename(session.filename) === normalizedRecoveryFilename(file.name)
    && positiveSafeInteger(session.expectedSize) === positiveSafeInteger(file.size)
    && normalizedRecoveryHash(session.expectedHash),
  );
}

/**
 * Binds reload recovery to the exact discovered session, server-normalized file
 * identity, and the browser-computed whole-file SHA-256. A missing server hash is
 * intentionally not recoverable; the user may only cancel that old reservation.
 */
export function collaborationAssetUploadRecoveryBinding(input: {
  session: CollaborationAssetUploadRecoverySessionIdentity;
  file: CollaborationAssetUploadRecoveryFileIdentity;
  discoveredSessionId: string;
  discoveredExpectedHash: string;
}): CollaborationAssetUploadRecoveryBinding {
  const sessionId = String(input.session.sessionId || '');
  if (!sessionId || sessionId !== String(input.discoveredSessionId || '')) {
    return {
      ok: false,
      code: 'asset_upload_recovery_session_mismatch',
      message: '服务器返回的上传会话与所选预留不一致，已停止恢复',
    };
  }
  const serverFilename = normalizedRecoveryFilename(input.session.filename);
  const localFilename = normalizedRecoveryFilename(input.file.name);
  const serverSize = positiveSafeInteger(input.session.expectedSize);
  const localSize = positiveSafeInteger(input.file.size);
  if (!serverFilename || !localFilename || serverSize === null || localSize === null
    || positiveSafeInteger(input.session.chunkSize) === null) {
    return {
      ok: false,
      code: 'asset_upload_recovery_metadata_invalid',
      message: '旧上传会话缺少安全恢复所需的文件元数据，请取消后重新上传',
    };
  }
  if (serverFilename !== localFilename) {
    return {
      ok: false,
      code: 'asset_upload_recovery_filename_mismatch',
      message: '所选文件名与旧上传会话不一致，请选择原文件',
    };
  }
  if (serverSize !== localSize) {
    return {
      ok: false,
      code: 'asset_upload_recovery_size_mismatch',
      message: '所选文件大小与旧上传会话不一致，请选择原文件',
    };
  }
  const discoveredHash = normalizedRecoveryHash(input.discoveredExpectedHash);
  const serverHash = normalizedRecoveryHash(input.session.expectedHash);
  const localHash = normalizedRecoveryHash(input.file.contentHash);
  if (!discoveredHash || !serverHash || !localHash) {
    return {
      ok: false,
      code: 'asset_upload_recovery_hash_missing',
      message: '旧上传会话缺少可验证的 SHA-256，只能取消并释放预留空间',
    };
  }
  if (serverHash !== discoveredHash || localHash !== serverHash) {
    return {
      ok: false,
      code: 'asset_upload_recovery_hash_mismatch',
      message: '所选文件内容与旧上传会话的 SHA-256 不一致，请选择原文件',
    };
  }
  return { ok: true };
}

export function collaborationAssetUploadConnectivityAction(input: {
  online: boolean;
  activeScopeKey: string;
  taskScopeKey: string;
  phase: string;
}): CollaborationAssetUploadConnectivityAction {
  const activeScopeKey = String(input.activeScopeKey || '');
  const taskScopeKey = String(input.taskScopeKey || '');
  const phase = String(input.phase || '');
  if (TERMINAL_UPLOAD_PHASES.has(phase)) return 'continue';
  if (!activeScopeKey || !taskScopeKey || activeScopeKey !== taskScopeKey) return 'scope-conflict';
  if (MANUALLY_HELD_UPLOAD_PHASES.has(phase)) return 'continue';
  if (!input.online) return phase === 'offline' ? 'continue' : 'suspend';
  return phase === 'offline' ? 'resume' : 'continue';
}

export function collaborationAssetUploadErrorKind(error: unknown): CollaborationAssetUploadErrorKind {
  const record = asRecord(error);
  const code = String(record.code || '').toLowerCase();
  const status = Number(record.status);
  if (code.includes('quota')) return 'quota';
  if (status === 401 || status === 403 || code.includes('permission') || code.includes('forbidden')) {
    return 'permission';
  }
  if (code.includes('storage') || code.includes('disk') || code.includes('capacity') || code.startsWith('cas_')) return 'storage';
  if (code.includes('conflict')
    || code.includes('mismatch')
    || code.includes('expired')
    || code.includes('scope')
    || code.includes('state')
    || code.includes('range')
    || code.includes('hash')
    || code.includes('incomplete')
    || code.includes('grant')) return 'conflict';
  return 'general';
}

export function collaborationAssetUploadErrorCode(error: unknown): string | undefined {
  const code = String(asRecord(error).code || '').trim();
  return /^asset_upload_[a-z0-9_]+$/.test(code) || /^CAS_[A-Z0-9_]+$/.test(code)
    ? code
    : undefined;
}
