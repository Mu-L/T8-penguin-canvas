import assert from 'node:assert/strict';
import test from 'node:test';
import {
  collaborationAssetUploadConnectivityAction,
  collaborationAssetUploadErrorCode,
  collaborationAssetUploadErrorKind,
  collaborationAssetUploadRecoveryBinding,
  collaborationAssetUploadRecoveryMetadataMatches,
} from '../src/utils/collaborationAssetUploadState.ts';

const connectivity = (overrides: Partial<Parameters<typeof collaborationAssetUploadConnectivityAction>[0]> = {}) => (
  collaborationAssetUploadConnectivityAction({
    online: true,
    activeScopeKey: 'session-a\u0001project-a\u0001canvas-a\u00011',
    taskScopeKey: 'session-a\u0001project-a\u0001canvas-a\u00011',
    phase: 'uploading',
    ...overrides,
  })
);

test('F5 upload connectivity suspends and resumes only inside the exact authorization scope', () => {
  assert.equal(connectivity(), 'continue');
  assert.equal(connectivity({ online: false }), 'suspend');
  assert.equal(connectivity({ online: false, phase: 'offline' }), 'continue');
  assert.equal(connectivity({ phase: 'offline' }), 'resume');
  assert.equal(connectivity({ online: false, phase: 'paused' }), 'continue');
  assert.equal(connectivity({ phase: 'paused' }), 'continue');
  assert.equal(connectivity({ online: false, phase: 'error' }), 'continue');
  assert.equal(connectivity({ taskScopeKey: 'session-b\u0001project-a\u0001canvas-a\u00011' }), 'scope-conflict');
  assert.equal(connectivity({ taskScopeKey: 'session-a\u0001project-a\u0001canvas-b\u00011' }), 'scope-conflict');
  assert.equal(connectivity({ taskScopeKey: 'session-a\u0001project-a\u0001canvas-a\u00012' }), 'scope-conflict');
  assert.equal(connectivity({ activeScopeKey: '' }), 'scope-conflict');
});

test('F5 terminal upload cards never restart after disconnect or a later scope change', () => {
  for (const phase of ['completed', 'cancelled', 'scope-conflict']) {
    assert.equal(connectivity({
      online: false,
      activeScopeKey: 'new-scope',
      taskScopeKey: 'old-scope',
      phase,
    }), 'continue');
  }
});

test('F5 upload errors route to dedicated quota, permission, storage, conflict, and general states', () => {
  assert.equal(collaborationAssetUploadErrorKind({ code: 'asset_upload_member_quota_exceeded', status: 413 }), 'quota');
  assert.equal(collaborationAssetUploadErrorKind({ code: 'asset_upload_permission_denied', status: 403 }), 'permission');
  assert.equal(collaborationAssetUploadErrorKind({ code: 'CAS_VERIFY_FAILED', status: 422 }), 'storage');
  assert.equal(collaborationAssetUploadErrorKind({ code: 'asset_upload_storage_full', status: 507 }), 'storage');
  assert.equal(collaborationAssetUploadErrorKind({ code: 'asset_upload_post_commit_capacity', status: 507 }), 'storage');
  assert.equal(collaborationAssetUploadErrorKind({ code: 'asset_upload_chunk_disk_missing', status: 409 }), 'storage');
  assert.equal(collaborationAssetUploadErrorKind({ code: 'asset_upload_file_hash_mismatch', status: 422 }), 'conflict');
  assert.equal(collaborationAssetUploadErrorKind({ code: 'asset_upload_incomplete', status: 409 }), 'conflict');
  assert.equal(collaborationAssetUploadErrorKind({ code: 'asset_upload_session_expired', status: 410 }), 'conflict');
  assert.equal(collaborationAssetUploadErrorKind(new Error('network failed')), 'general');
});

test('F5 exposes only stable upload or CAS error codes to the task UI', () => {
  assert.equal(collaborationAssetUploadErrorCode({ code: 'asset_upload_chunk_conflict' }), 'asset_upload_chunk_conflict');
  assert.equal(collaborationAssetUploadErrorCode({ code: 'CAS_VERIFY_FAILED' }), 'CAS_VERIFY_FAILED');
  assert.equal(collaborationAssetUploadErrorCode({ code: String.raw`ENOENT C:\Users\host\secret.part` }), undefined);
  assert.equal(collaborationAssetUploadErrorCode({ code: 'asset_upload_BAD' }), undefined);
  assert.equal(collaborationAssetUploadErrorCode({ code: 'CAS_bad' }), undefined);
});

test('F5 reload recovery metadata matching is exact and requires a server SHA-256', () => {
  const session = {
    sessionId: 'asset-upload-current-scope-0001',
    filename: 'café.txt',
    expectedSize: 128,
    expectedHash: 'a'.repeat(64),
    chunkSize: 1024 * 1024,
  };
  assert.equal(collaborationAssetUploadRecoveryMetadataMatches(session, {
    name: 'cafe\u0301.txt',
    size: 128,
  }), true, 'NFKC-equivalent browser names must bind to the normalized server name');
  assert.equal(collaborationAssetUploadRecoveryMetadataMatches(session, {
    name: 'café.txt',
    size: 129,
  }), false);
  assert.equal(collaborationAssetUploadRecoveryMetadataMatches({ ...session, expectedHash: null }, {
    name: 'café.txt',
    size: 128,
  }), false, 'hashless sessions may be cancelled but never resumed');
});

test('F5 reload recovery binds the discovered session, fresh server snapshot, and local whole-file hash', () => {
  const expectedHash = 'b'.repeat(64);
  const session = {
    sessionId: 'asset-upload-current-scope-0002',
    filename: 'original.txt',
    expectedSize: 256,
    expectedHash,
    chunkSize: 1024 * 1024,
  };
  const bind = (overrides: Record<string, unknown> = {}, fileOverrides: Record<string, unknown> = {}, pinnedOverrides: Record<string, string> = {}) => (
    collaborationAssetUploadRecoveryBinding({
      session: { ...session, ...overrides },
      file: { name: 'original.txt', size: 256, contentHash: expectedHash, ...fileOverrides },
      discoveredSessionId: pinnedOverrides.sessionId || session.sessionId,
      discoveredExpectedHash: pinnedOverrides.expectedHash || expectedHash,
    })
  );

  assert.deepEqual(bind(), { ok: true });
  assert.equal(bind({ sessionId: 'asset-upload-other' }).code, 'asset_upload_recovery_session_mismatch');
  assert.equal(bind({ filename: 'other.txt' }).code, 'asset_upload_recovery_filename_mismatch');
  assert.equal(bind({ expectedSize: 257 }).code, 'asset_upload_recovery_size_mismatch');
  assert.equal(bind({ expectedHash: null }).code, 'asset_upload_recovery_hash_missing');
  assert.equal(bind({}, { contentHash: 'c'.repeat(64) }).code, 'asset_upload_recovery_hash_mismatch');
  assert.equal(bind({}, {}, { expectedHash: 'd'.repeat(64) }).code, 'asset_upload_recovery_hash_mismatch');
});
