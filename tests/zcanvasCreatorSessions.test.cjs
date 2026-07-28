'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  getCreatorSession,
  listCreatorSessions,
  mergeCreatorSessionAuthority,
  saveCreatorSession,
} = require('../tools/zcanvas-cli/src/creatorSessions.cjs');
const { hasAppliedCreatorProduction } = require('../tools/zcanvas-cli/src/cli.cjs');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zcanvas-creator-session-'));
  return {
    root,
    options: {
      env: { ZCANVAS_CREATOR_SESSION_STORE: path.join(root, 'sessions.json') },
      homeDir: root,
    },
  };
}

test('creator session persists exact canvas context and can be resumed without exposing full prompt in list', () => {
  const state = fixture();
  try {
    const saved = saveCreatorSession({
      instanceId: 'instance-a',
      projectId: 'project-local',
      canvasId: 'canvas-a',
      prompt: '为一把透明折叠伞制作20秒竖屏雨季广告',
      kind: 'story',
      request: { kind: 'story', title: '雨季广告' },
      planId: 'plan-a',
      planDigest: 'digest-a',
    }, state.options);
    assert.match(saved.id, /^cs_[A-Za-z0-9_-]+$/);
    assert.equal(getCreatorSession(saved.id, state.options).canvasId, 'canvas-a');
    const resumed = saveCreatorSession({
      ...saved,
      prompt: `${saved.prompt}\n\n继续要求：只把背景改成清晨`,
      status: 'planned',
      planId: 'plan-b',
      planDigest: 'digest-b',
      lastDirection: '只把背景改成清晨',
      incrementalPlan: {
        schema: 't8-creator-incremental-plan-v1',
        operation: 'story.revise-affected',
        scope: 'explicit-affected-only',
      },
    }, state.options);
    assert.equal(resumed.id, saved.id);
    assert.equal(getCreatorSession(saved.id, state.options).planId, 'plan-b');
    assert.equal(getCreatorSession(saved.id, state.options).lastDirection, '只把背景改成清晨');
    assert.equal(
      getCreatorSession(saved.id, state.options).incrementalPlan.operation,
      'story.revise-affected',
    );
    assert.equal(hasAppliedCreatorProduction(resumed), false);
    assert.equal(hasAppliedCreatorProduction({
      ...resumed,
      status: 'applied',
      storyNodeId: 'story-node-a',
    }), true);
    assert.equal(hasAppliedCreatorProduction({
      ...resumed,
      status: 'needs-incremental-plan',
      linkedNodeId: 'image-node-a',
    }), true);
    const listed = listCreatorSessions(state.options);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].title, '雨季广告');
    assert.equal(Object.hasOwn(listed[0], 'prompt'), false);
  } finally {
    fs.rmSync(state.root, { recursive: true, force: true });
  }
});

test('canvas CreatorSession is authoritative for plan, approval evidence, progress, lineage, and results', () => {
  const state = fixture();
  try {
    const checkpoint = saveCreatorSession({
      instanceId: 'instance-a',
      projectId: 'project-local',
      canvasId: 'canvas-a',
      prompt: '旧的本机创作要求',
      kind: 'image',
      request: { kind: 'image', prompt: '旧的本机创作要求' },
      planId: 'plan-old',
      planDigest: 'digest-old',
      status: 'planned',
    }, state.options);
    const remote = {
      schema: 't8-creator-agent-session-v1',
      id: checkpoint.id,
      projectId: checkpoint.projectId,
      canvasId: checkpoint.canvasId,
      status: 'active',
      phase: 'shots',
      lastSequence: 18,
      updatedAt: '2026-07-28T10:00:00.000Z',
      latestPlan: {
        planId: 'plan-authoritative',
        planDigest: 'digest-authoritative',
        expiresAt: '2026-07-28T10:30:00.000Z',
        ready: true,
        kind: 'story',
        profile: 'quality',
        brief: { goal: 'Canvas 中已经完善过的雨夜短片' },
        targets: {
          primaryNodeId: 'story-node-a',
          storyNodeId: 'story-node-a',
        },
      },
      production: {
        schema: 't8-creator-production-state-v1',
        currentPhase: 'shots',
        completedPhases: ['idea', 'script', 'assets'],
      },
      context: {
        assetLineage: [{
          assetId: 'asset-character',
          kind: 'image',
          parentAssetIds: [],
          sourceNodeIds: ['upload-a'],
        }],
      },
      runLinks: [{
        planId: 'plan-authoritative',
        patchId: 'patch-a',
        runId: 'run-a',
        matchedNodeIds: ['story-node-a'],
      }],
      artifactVerifications: [{
        runId: 'run-a',
        verified: true,
        verificationDigest: 'verification-a',
        assets: [{ assetId: 'asset-video-a' }],
      }],
      deliveryEvidence: [{
        approvalRequestId: 'approval-delivery-a',
        planId: 'plan-authoritative',
        status: 'completed',
        valid: true,
        packageDigest: 'package-a',
      }],
      events: [
        {
          sequence: 17,
          type: 'plan.previewed',
          payload: { planId: 'plan-authoritative', planDigest: 'digest-authoritative' },
          createdAt: '2026-07-28T09:59:00.000Z',
        },
        {
          sequence: 18,
          type: 'plan.applied',
          payload: {
            planId: 'plan-authoritative',
            planDigest: 'digest-authoritative',
            patchId: 'patch-a',
          },
          createdAt: '2026-07-28T10:00:00.000Z',
        },
      ],
    };
    const merged = saveCreatorSession(mergeCreatorSessionAuthority(checkpoint, remote), state.options);
    assert.equal(merged.planId, 'plan-authoritative');
    assert.equal(merged.planDigest, 'digest-authoritative');
    assert.equal(merged.prompt, 'Canvas 中已经完善过的雨夜短片');
    assert.equal(merged.kind, 'story');
    assert.equal(merged.profile, 'quality');
    assert.equal(merged.status, 'applied');
    assert.equal(merged.storyNodeId, 'story-node-a');
    assert.equal(hasAppliedCreatorProduction(merged), true);
    assert.equal(merged.authority.lastSequence, 18);
    assert.equal(merged.authority.approval.status, 'applied');
    assert.equal(merged.authority.approval.transferable, false);
    assert.equal(merged.authority.production.currentPhase, 'shots');
    assert.equal(merged.authority.assetLineage[0].assetId, 'asset-character');
    assert.equal(merged.authority.runLinks[0].runId, 'run-a');
    assert.deepEqual(merged.authority.artifactVerifications[0].assetIds, ['asset-video-a']);
    assert.equal(merged.authority.deliveryEvidence[0].valid, true);
    assert.equal(listCreatorSessions(state.options)[0].authorityCursor, 18);
  } finally {
    fs.rmSync(state.root, { recursive: true, force: true });
  }
});

test('authority merge rejects a different CreatorSession or canvas', () => {
  const checkpoint = {
    id: 'cs_0123456789abcdefghijklmnop',
    projectId: 'project-local',
    canvasId: 'canvas-a',
  };
  assert.throws(
    () => mergeCreatorSessionAuthority(checkpoint, {
      id: checkpoint.id,
      projectId: checkpoint.projectId,
      canvasId: 'canvas-b',
    }),
    (error) => error.code === 'CREATOR_SESSION_AUTHORITY_MISMATCH',
  );
  const restoredFromProductionCheckpoint = mergeCreatorSessionAuthority({
    ...checkpoint,
    instanceId: 'instance-a',
    prompt: '恢复作品',
  }, {
    ...checkpoint,
    status: 'active',
    latestPlan: {
      planId: 'plan-a',
      planDigest: 'digest-a',
      targets: { primaryNodeId: 'story-a', storyNodeId: 'story-a' },
    },
    production: {
      currentPhase: 'shots',
      checkpoint: { type: 'plan.applied', planId: 'plan-a' },
    },
    events: [],
  });
  assert.equal(restoredFromProductionCheckpoint.status, 'applied');
  assert.equal(hasAppliedCreatorProduction(restoredFromProductionCheckpoint), true);
});

test('continue refreshes the backend authority before deciding whether production is already applied', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'tools', 'zcanvas-cli', 'src', 'cli.cjs'),
    'utf8',
  );
  const start = source.indexOf('async function handleContinue');
  const end = source.indexOf('function handleSessions', start);
  assert.ok(start >= 0 && end > start);
  const body = source.slice(start, end);
  const authorityRead = body.indexOf('await readAuthoritativeCreatorSession');
  const appliedDecision = body.indexOf('hasAppliedCreatorProduction(creatorSession)');
  assert.ok(authorityRead >= 0);
  assert.ok(appliedDecision > authorityRead);
  assert.match(source, /CREATOR_SESSION_AUTHORITY_NOT_FOUND/);
});
