import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (relativePath: string) => readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8').replace(/\r\n?/g, '\n');
const workspace = read('src/components/CollaborationWorkspace.tsx');
const hostPanel = read('src/components/CollaborationHostPanel.tsx');
const api = read('src/services/api.ts');
const types = read('src/types/project.ts');

function section(source: string, start: string, end: string) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(from, -1, `missing section start: ${start}`);
  assert.notEqual(to, -1, `missing section end: ${end}`);
  return source.slice(from, to);
}

test('F7 initializes a bounded run snapshot, resumes an authenticated event cursor, and validates detail scope', () => {
  const detail = section(workspace, 'const loadSharedRunDetail = useCallback', 'const syncCollaborationRuns = useCallback');
  const sync = section(workspace, 'const syncCollaborationRuns = useCallback', 'const initializeCollaborationRuns = useCallback');
  const initialize = section(workspace, 'const initializeCollaborationRuns = useCallback', 'const loadCanvas = useCallback');

  assert.match(initialize, /collabEnvelopeRequest<unknown\[\]>\('\/api\/collab\/runs\?limit=50'\)/);
  assert.match(initialize, /normalizeCollaborationRun\(item, activeSession\.canvasId\)/);
  assert.match(initialize, /normalized\.length !== rawRuns\.length/);
  assert.match(initialize, /await syncCollaborationRuns\(activeSession\)/);

  assert.match(sync, /\/api\/collab\/runs\/sync\?afterEventId=\$\{cursor\}&limit=1000/);
  assert.match(sync, /afterEventId !== cursor/);
  assert.match(sync, /nextCursor < cursor/);
  assert.match(sync, /limit < 1 \|\| limit > 1000/);
  assert.match(sync, /events\.filter\(\(event\) => event\.id > cursor\)/);
  assert.match(sync, /event\.id <= events\[index - 1\]\.id/);
  assert.match(sync, /nextCursor !== expectedNextCursor/);
  assert.match(sync, /hasMore && nextCursor === cursor/);
  assert.match(sync, /collaborationRunEventCursorRef\.current = cursor/);
  assert.match(sync, /mergeCollaborationRunEvent\(next, event, activeSession\.canvasId\)/);
  assert.match(sync, /boundedCollaborationRuns\(unseen\.reduce/);

  assert.match(detail, /\/api\/collab\/runs\/\$\{encodeURIComponent\(normalizedRunId\)\}/);
  assert.match(detail, /collaborationRunScopeKey\(currentSession, authoritativeGenerationRef\.current\) !== scopeKey/);
  assert.match(detail, /normalizeCollaborationRun\(raw, currentSession\.canvasId\)/);
  assert.match(detail, /detail\.id !== normalizedRunId/);
});

test('F7 merges websocket run events with the same strict normalizers and refreshes authoritative detail', () => {
  const websocketRuns = section(
    workspace,
    "if (['run.intent', 'run.intent-state'].includes(String(message.type))",
    "if (message.type === 'presence.snapshot'",
  );
  for (const eventType of ['run.intent', 'run.intent-state', 'run.state', 'run.node-state', 'run.output', 'run.event']) {
    assert.match(websocketRuns, new RegExp(eventType.replace('.', '\\.') ));
  }
  assert.match(websocketRuns, /normalizeCollaborationRunIntentView\(message\.intent, session\.canvasId\)/);
  assert.match(websocketRuns, /normalizeCollaborationRun\(message\.run, session\.canvasId/);
  assert.match(websocketRuns, /normalizeCollaborationRunNode\(message\.node, runId\)/);
  assert.match(websocketRuns, /\.map\(normalizeCollaborationRunAsset\)/);
  assert.match(websocketRuns, /normalizeCollaborationRunEvent\(message\.event\)/);
  assert.match(websocketRuns, /loadSharedRunDetail\(run(?:Event\.)?\.id|loadSharedRunDetail\(runId|loadSharedRunDetail\(runEvent\.runId/);
  assert.match(websocketRuns, /socket\.close\(1008, 'invalid run/);

  const merger = section(workspace, 'export function mergeCollaborationRun(', 'export function mergeCollaborationRunEvent(');
  assert.match(merger, /incoming\.updatedAt >= existing\.updatedAt/);
  assert.match(merger, /new Map\(existing\.nodes\.map/);
  assert.match(merger, /new Map\(existing\.assets\.map/);
  assert.match(merger, /updatedAt: Math\.max\(existing\.updatedAt, incoming\.updatedAt\)/);
});

test('F7 public Run, NodeRun, Attempt rendering uses fixed allowlists and never renders hidden payload snapshots', () => {
  const eventNormalizer = section(workspace, 'export function normalizeCollaborationRunEvent', 'export function mergeCollaborationRun(');
  const runUi = section(workspace, 'data-testid="collaboration-shared-run-center"', '<section className="mb-5 border-y border-[var(--border-primary)] py-4">');
  const attemptTypes = section(types, 'export interface CollaborationRunAttempt', 'export interface CollaborationRunNode');

  assert.ok(workspace.includes("!/^\\/api\\/collab\\/assets\\/[^/]+\\/(?:media|preview|thumbnail)$/.test(resolved.pathname)"));
  assert.match(workspace, /resolved\.origin !== window\.location\.origin/);
  assert.match(workspace, /\['costUsd', 'inputTokens', 'outputTokens', 'totalTokens', 'durationMs', 'requestCount'\]/);
  assert.match(workspace, /record\.kind/);
  assert.match(workspace, /record\.code/);
  assert.match(workspace, /record\.message/);
  assert.doesNotMatch(eventNormalizer, /payload:\s*isPlainRecord\(value\.payload\)/);
  assert.doesNotMatch(eventNormalizer, /prompt|inputSnapshot|requestBody|headers|apiKey/i);

  assert.match(runUi, /查看 Run\/NodeRun\/Attempt/);
  assert.match(runUi, /collaborationRunProgress\(run\)/);
  assert.match(runUi, /collaborationRunUsageEntries\(attempt\.usage\)/);
  assert.match(runUi, /attempt\.error\.message/);
  assert.doesNotMatch(runUi, /JSON\.stringify|inputSnapshot|prompt|negativePrompt|requestBody|apiKey/i);
  assert.doesNotMatch(attemptTypes, /prompt|inputSnapshot|requestBody|headers|apiKey/i);
});

test('F7 requester cancellation is exact-scope and sends only the queue CAS on the public route', () => {
  const cancel = section(workspace, 'const cancelOwnRunIntent = async', 'const openSharedRunDetail = async');
  assert.match(cancel, /intent\.canvasId !== activeSession\.canvasId/);
  assert.match(cancel, /intent\.requestedBy !== activeSession\.memberId/);
  assert.match(cancel, /!Number\.isSafeInteger\(intent\.queueRevision\)/);
  assert.match(cancel, /\/api\/collab\/run-intents\/\$\{encodeURIComponent\(intent\.id\)\}\/cancel/);
  assert.match(cancel, /body: JSON\.stringify\(\{ expectedQueueRevision: intent\.queueRevision \}\)/);
  assert.match(cancel, /cancelled\.requestedBy !== activeSession\.memberId \|\| cancelled\.id !== intent\.id/);
  const requestBody = cancel.match(/body: JSON\.stringify\([^\n]+/i)?.[0] || '';
  assert.doesNotMatch(requestBody, /projectId|canvasId/);
});

test('F7 owner queue management exposes complete room policy CAS plus accept, cancel, retry and lease evidence', () => {
  assert.match(hostPanel, /data-testid="collaboration-room-execution-policy"/);
  assert.match(hostPanel, /api\.getCollaborationRoomExecutionPolicy\(projectId, canvasId/);
  assert.match(hostPanel, /api\.updateCollaborationRoomExecutionPolicy\(projectId, canvasId, \{\s+expectedRevision: roomExecutionPolicy\.policy\.revision,\s+allowEditorRuns: roomAllowEditorRuns,\s+memberDailyRunLimit,\s+canvasConcurrencyLimit,\s+autoApproveLowRisk: roomAutoApproveLowRisk,\s+highCostConfirmationThreshold,\s+requireUnknownCostConfirmation: roomRequireUnknownCostConfirmation,/);
  assert.match(hostPanel, /roomExecutionPolicy\.policy\.revision < 0/);
  assert.match(hostPanel, /usage\.queuedCount/);

  assert.match(hostPanel, /api\.acceptCollaborationRunIntent\(intent\.id, projectId, canvasId, \{\s+expectedQueueRevision: Number\(intent\.queueRevision\),/);
  assert.match(hostPanel, /api\.cancelCollaborationRunIntent\(intent\.id, projectId, canvasId, \{\s+expectedQueueRevision: Number\(intent\.queueRevision\),/);
  assert.match(hostPanel, /onAcceptRunIntent\(accepted\)/);
  assert.match(hostPanel, /intent\.status === 'accepted' && intent\.confirmationRequired !== false/);
  assert.match(hostPanel, /执行已确认请求/);
  for (const evidence of ['queueRevision', 'confirmationRequired', 'dispatchAttempts', 'nextAttemptAt', 'leaseExpiresAt', 'cancelRequestedAt', 'cancelledAt', 'lastErrorMessage']) {
    assert.match(hostPanel, new RegExp(`intent\\.${evidence}`));
  }
  assert.doesNotMatch(hostPanel, /intent\.(?:leaseToken|leaseOwner)/);

  assert.match(api, /export async function updateCollaborationRunIntent\([\s\S]*CollaborationRunIntentQueueMutationInput & \{ status: 'rejected' \| 'stale' \}/);
  assert.match(api, /export async function acceptCollaborationRunIntent/);
  assert.match(api, /export async function cancelCollaborationRunIntent/);
  assert.match(api, /body: JSON\.stringify\(\{ projectId, canvasId, \.\.\.input \}\)/);
});

test('F7 shared DTOs include queue accounting without exposing one-shot execution lease credentials', () => {
  const roomPolicy = section(types, 'export interface CollaborationRoomExecutionPolicy {', 'export interface CollaborationReviewVisibilityPolicy {');
  const intentView = section(types, 'export interface CollaborationRunIntentView', 'export interface CollaborationRoomExecutionPolicy');
  const runIntent = section(types, 'export interface RunIntent {', '\n}');
  const executionUsage = section(types, 'export interface CollaborationExecutionUsage {', 'export interface CollaborationExecutionPolicySnapshot');

  for (const field of ['allowEditorRuns', 'memberDailyRunLimit', 'canvasConcurrencyLimit', 'autoApproveLowRisk', 'highCostConfirmationThreshold', 'requireUnknownCostConfirmation', 'revision']) {
    assert.match(roomPolicy, new RegExp(`${field}:`));
  }
  assert.match(executionUsage, /queuedCount: number/);
  for (const value of [intentView, runIntent]) {
    assert.match(value, /queueRevision\?: number/);
    assert.match(value, /leaseExpiresAt\?: number \| null/);
    assert.doesNotMatch(value, /leaseToken|leaseOwner/);
  }
});
