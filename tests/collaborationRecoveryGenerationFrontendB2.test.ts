import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const workspace = readFileSync(
  new URL('../src/components/CollaborationWorkspace.tsx', import.meta.url),
  'utf8',
).replace(/\r\n?/g, '\n');
const queue = readFileSync(
  new URL('../src/utils/collaborationOfflineQueue.ts', import.meta.url),
  'utf8',
).replace(/\r\n?/g, '\n');

function section(source: string, start: string, end: string) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.ok(startIndex >= 0, `missing section start: ${start}`);
  assert.ok(endIndex > startIndex, `missing section end: ${end}`);
  return source.slice(startIndex, endIndex);
}

test('B2 offline queue storage is recovery-generation scoped and rejects revision ABA across generations', () => {
  assert.match(queue, /COLLABORATION_QUEUE_STORAGE_VERSION = 3/);
  assert.match(queue, /interface CollaborationQueueScope \{[\s\S]*authorizationEpoch: number;[\s\S]*recoveryGeneration: string;/);
  assert.match(queue, /value\.recoveryGeneration === value\.recoveryGeneration\.toLowerCase\(\)/);
  assert.match(queue, /left\.authorizationEpoch === right\.authorizationEpoch[\s\S]*left\.recoveryGeneration === right\.recoveryGeneration/);
  assert.match(queue, /scope\.authorizationEpoch,[\s\S]*scope\.recoveryGeneration,/);
  assert.match(queue, /`t8-collaboration-queue:v\$\{COLLABORATION_QUEUE_STORAGE_VERSION\}:/);
});

test('B2 every workspace mutation uses one immutable generation and authorization-epoch fence', () => {
  const capture = section(
    workspace,
    'const captureMutationFence = useCallback',
    'const assertMutationFenceCurrent = useCallback',
  );
  assert.match(capture, /authorizationEpoch: currentSession\.authorizationEpoch/);
  assert.match(capture, /recoveryGeneration,/);
  assert.match(capture, /scopeGeneration: queueScopeGenerationRef\.current/);

  const assertCurrent = section(
    workspace,
    'const assertMutationFenceCurrent = useCallback',
    'const collaborationMutationRequest = useCallback',
  );
  for (const guard of [
    'fence.scopeGeneration !== queueScopeGenerationRef.current',
    'fence.sessionId !== currentSession.id',
    'fence.authorizationEpoch !== currentSession.authorizationEpoch',
    'fence.recoveryGeneration !== authoritativeGenerationRef.current',
  ]) assert.match(assertCurrent, new RegExp(guard.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

  const request = section(
    workspace,
    'const collaborationMutationRequest = useCallback',
    'const scopedCollaborationReviewRequest = useCallback',
  );
  assert.match(request, /recoveryGeneration: fence\.recoveryGeneration/);
  assert.match(request, /assertCurrent: \(\) => assertMutationFenceCurrent\(fence\)/);

  const transport = section(workspace, 'async function collabEnvelopeRequest', 'async function collabRequest');
  assert.doesNotMatch(workspace, /activeCollaborationRecoveryGeneration/);
  const fetchIndex = transport.indexOf('const response = await fetch');
  assert.ok(transport.indexOf('options.assertCurrent?.()') < fetchIndex);
  assert.ok(transport.lastIndexOf('options.assertCurrent?.()') > fetchIndex);
  assert.match(transport, /suppliedRecoveryGeneration !== requestedRecoveryGeneration/);
  assert.match(transport, /headers\.set\('X-T8-Canvas-Generation', requestedRecoveryGeneration\)/);
});

test('B2 exact retry and child review mutations cannot borrow a later ambient generation', () => {
  const structure = section(
    workspace,
    'const submitStructuralOperations = useCallback',
    'const onNodesChange = useCallback',
  );
  const fenceIndex = structure.indexOf('const mutationFence = captureMutationFence()');
  const retryIndex = structure.indexOf('for (let exactRetry = 0; exactRetry < 2; exactRetry += 1)');
  const requestIndex = structure.indexOf('collaborationMutationRequest<unknown>');
  assert.ok(fenceIndex >= 0 && retryIndex > fenceIndex && requestIndex > retryIndex);
  assert.match(structure.slice(requestIndex), /mutationFence,[\s\S]*requestBody/);

  const textSubmit = section(workspace, 'export async function submitCollaborationTextUpdate', 'function displayNode');
  assert.match(textSubmit, /recoveryGeneration: options\.recoveryGeneration/);
  assert.match(textSubmit, /assertCurrent: assertCurrentScope/);
  assert.match(workspace, /submitCollaborationTextUpdate\(envelope, assertCurrentScope, \{[\s\S]*recoveryGeneration: mutationFence\.recoveryGeneration/);
  assert.match(workspace, /request=\{scopedCollaborationReviewRequest\}/);
});

test('B2 generation transition accepts the authoritative snapshot before activating and flushing its queue', () => {
  const bootstrap = section(workspace, 'const bootstrap = useCallback', 'const clearVisibleWorkspaceAfterLogout');
  const loadIndex = bootstrap.indexOf('await loadCanvas(nextSession.canvasId');
  const recoverIndex = bootstrap.indexOf('await canvasRecoveryRef.current');
  const runIndex = bootstrap.indexOf('await initializeCollaborationRuns(nextSession)');
  assert.ok(loadIndex >= 0 && recoverIndex > loadIndex && runIndex > recoverIndex);
  assert.doesNotMatch(bootstrap.slice(0, recoverIndex), /activateQueueScope\(/);

  const recover = section(workspace, 'const recoverCanvas = useCallback', 'const flushOfflineQueue = useCallback');
  assert.match(recover, /recoveryGenerationChanged[\s\S]*sync\.mode !== 'snapshot'[\s\S]*sync\.reason !== 'recovery_generation_changed'/);
  const acceptIndex = recover.indexOf('acceptAuthoritativeDocument(next, { allowRevisionRegression })');
  const activateIndex = recover.indexOf('activateQueueScope(', acceptIndex);
  assert.ok(acceptIndex >= 0 && activateIndex > acceptIndex, 'new generation queue must activate only after the snapshot lands');

  const flush = section(workspace, 'const flushOfflineQueue = useCallback', 'useEffect(() => {',);
  assert.match(flush, /const mutationFence = captureMutationFence\(\)/);
  assert.match(flush, /baseRevision: live\.baseRevision/);
  assert.match(flush, /await recoverCanvas\(0\);[\s\S]*scopeGeneration !== queueScopeGenerationRef\.current/);
  assert.doesNotMatch(flush, /canvas_generation_changed[\s\S]{0,800}baseRevision: null/);
});

test('B2 generation fences discard stale text binding and run read responses', () => {
  const runScope = section(
    workspace,
    'export function collaborationRunScopeKey',
    'function withMergedCollaborationRun',
  );
  assert.match(runScope, /normalizeCollaborationRecoveryGeneration\(recoveryGeneration\)/);
  assert.match(runScope, /if \(!normalizedRecoveryGeneration\) return ''/);
  assert.match(runScope, /value\.authorizationEpoch,[\s\S]*normalizedRecoveryGeneration/);

  const runDetail = section(
    workspace,
    'const loadSharedRunDetail = useCallback',
    'const syncCollaborationRuns = useCallback',
  );
  assert.match(runDetail, /collaborationRunScopeKey\(currentSession, authoritativeGenerationRef\.current\) !== scopeKey/);

  const runSync = section(
    workspace,
    'const syncCollaborationRuns = useCallback',
    'const initializeCollaborationRuns = useCallback',
  );
  const responseIndex = runSync.indexOf('const response = await collabEnvelopeRequest');
  const responseFenceIndex = runSync.indexOf('collaborationRunScopeKey(responseSession, authoritativeGenerationRef.current) !== scopeKey');
  assert.ok(responseIndex >= 0 && responseFenceIndex > responseIndex);

  const selectedBinding = section(
    workspace,
    'const selectedNodeTitleKey = selectedNodeEntityUid',
    'const openReviewCommentBody = useCallback',
  );
  const reviewBinding = section(
    workspace,
    'const openReviewCommentBody = useCallback',
    'useEffect(() => {\n    if (!editingReviewTextKey)',
  );
  for (const binding of [selectedBinding, reviewBinding]) {
    assert.match(binding, /capturedQueueScopeGeneration = queueScopeGenerationRef\.current/);
    assert.match(binding, /capturedRecoveryGeneration = normalizeCollaborationRecoveryGeneration/);
    assert.match(binding, /capturedQueueScopeGeneration === queueScopeGenerationRef\.current/);
    assert.match(binding, /capturedRecoveryGeneration === normalizeCollaborationRecoveryGeneration/);
    assert.match(binding, /!isCurrentTextScope\(\)\) return/);
  }
});

test('B2 subflow and review reads cannot survive a recovery-generation cutover', () => {
  const bootstrap = section(workspace, 'const bootstrap = useCallback', 'const clearVisibleWorkspaceAfterLogout');
  const recoverIndex = bootstrap.indexOf('await canvasRecoveryRef.current');
  assert.ok(recoverIndex >= 0);
  assert.doesNotMatch(
    bootstrap.slice(0, recoverIndex),
    /collabRequest<SubflowDefinition\[]>\('\/api\/collab\/subflows'\)/,
  );

  const activation = section(workspace, 'const activateQueueScope = useCallback', 'const acceptAuthoritativeDocument = useCallback');
  assert.match(activation, /queueScopeGenerationRef\.current \+= 1;[\s\S]*setQueueScopeVersion/);
  assert.match(activation, /if \(recoveryGenerationChanged\) \{[\s\S]*setSubflows\(\[\]\)/);
  assert.match(activation, /if \(recoveryGenerationChanged\) \{[\s\S]*setReviews\(\[\]\)/);
  assert.match(activation, /if \(recoveryGenerationChanged\) \{[\s\S]*textMaterializedRevisionRef\.current\.clear\(\)/);
  assert.match(activation, /if \(recoveryGenerationChanged\) \{[\s\S]*setReviewRefreshToken/);

  const recover = section(workspace, 'const recoverCanvas = useCallback', 'const flushOfflineQueue = useCallback');
  const activateIndex = recover.indexOf('activateQueueScope(');
  const subflowReloadIndex = recover.indexOf('await loadSubflows(isActivatedSubflowScopeCurrent)', activateIndex);
  const runReloadIndex = recover.indexOf('await initializeCollaborationRuns(currentSession)', subflowReloadIndex);
  assert.ok(activateIndex >= 0 && subflowReloadIndex > activateIndex && runReloadIndex > subflowReloadIndex);
  assert.match(recover.slice(activateIndex), /activatedScopeGeneration === queueScopeGenerationRef\.current/);
  assert.match(recover.slice(activateIndex), /syncGeneration === normalizeCollaborationRecoveryGeneration/);

  const event = section(
    workspace,
    "if (message.type === 'subflow.published')",
    "if (['review.created', 'review.updated'",
  );
  assert.match(event, /subflowScopeGeneration = queueScopeGenerationRef\.current/);
  assert.match(event, /subflowRecoveryGeneration = normalizeCollaborationRecoveryGeneration/);
  assert.match(event, /subflowScopeGeneration === queueScopeGenerationRef\.current/);
  assert.match(event, /loadSubflows\(isCurrentSubflowScope\)/);
});

test('B2 generation cutover remounts socket and review state while preserving but fencing stale subflow drafts', () => {
  const socket = section(
    workspace,
    'useEffect(() => {\n    if (!session || !socketScopeReady || !authoritativeDocumentRef.current) return;',
    'useEffect(() => {\n    if (!session || !socketScopeReady || connectionState.phase',
  );
  assert.match(socket, /const scopeGeneration = queueScopeGenerationRef\.current/);
  assert.match(socket, /queueScopeGenerationRef\.current === scopeGeneration/);
  assert.match(socket, /queueScopeVersion,/);

  const subflow = section(workspace, 'const startSubflowPublication =', 'const orderedSharedRuns =');
  assert.match(subflow, /recoveryGeneration: currentRecoveryGeneration/);
  assert.match(subflow, /subflowDraft\.recoveryGeneration !== currentRecoveryGeneration/);
  assert.match(subflow, /recoveryGeneration: draft\.recoveryGeneration/);
  assert.match(workspace, /!subflowDraftGenerationCurrent/);
  assert.match(workspace, /key=\{`\$\{session\.id\}\\u0001\$\{session\.authorizationEpoch\}\\u0001\$\{currentRecoveryGeneration\}\\u0001\$\{queueScopeVersion\}`\}/);

  const logout = section(workspace, 'const clearVisibleWorkspaceAfterLogout = useCallback', 'const rotateParticipantSession = useCallback');
  assert.match(logout, /queueScopeGenerationRef\.current \+= 1;[\s\S]*setQueueScopeVersion/);
  assert.match(logout, /textMaterializedRevisionRef\.current\.clear\(\)/);

  const bootstrapEffect = section(workspace, 'useEffect(() => {\n    if (bootstrapStartedRef.current)', 'const recoverCanvas = useCallback');
  assert.match(bootstrapEffect, /bootstrapStartedRef\.current = true;[\s\S]*void bootstrap\(\)/);
});
