'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createAgentControlRunService,
  verifyCompletionEvidence,
} = require('../backend/src/services/agentControlRuns.js');

const VALID_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function fixture(options = {}) {
  const document = {
    schema: 't8-canvas-document',
    schemaVersion: 2,
    projectId: 'project-local',
    canvasId: 'canvas-a',
    revision: 9,
    nodes: [
      {
        id: 'image-a',
        type: 'image',
        position: { x: 0, y: 0 },
        data: { model: 'gpt-image-2', selectedModel: 'gpt-image-2' },
      },
    ],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  };
  const intentsById = new Map();
  const intentsByKey = new Map();
  const directory = options.withEvidence
    ? fs.mkdtempSync(path.join(os.tmpdir(), 't8-agent-run-evidence-'))
    : null;
  const artifactPath = directory ? path.join(directory, 'asset-a.png') : null;
  const artifactBytes = options.artifactBytes || VALID_PNG;
  if (artifactPath && options.omitArtifact !== true) fs.writeFileSync(artifactPath, artifactBytes);
  const artifactHash = sha256(options.expectedBytes || artifactBytes);
  let writes = 0;
  let providerPosts = 0;
  const baseEvidence = {
    run: {
      id: 'run-a',
      projectId: 'project-local',
      canvasId: 'canvas-a',
      canvasRevision: 9,
      status: 'completed',
      createdAt: 1,
      finishedAt: 2,
    },
    totals: { nodeRuns: 1, attempts: 1 },
    returned: { nodeRuns: 1, attempts: 1 },
    evidenceComplete: true,
    evidenceReasons: [],
    nodeRuns: [{
      id: 'node-run-a',
      runId: 'run-a',
      nodeId: 'image-a',
      originalNodeId: 'image-a',
      status: 'succeeded',
      inputSnapshot: {
        shotId: 'shot-a',
      },
      outputRefs: ['asset-a'],
    }],
    attemptsByNodeId: new Map([['node-run-a', [{ id: 'attempt-a', status: 'succeeded' }]]]),
  };
  const baseAsset = {
    id: 'asset-a',
    projectId: 'project-local',
    kind: 'image',
    mimeType: 'image/png',
    contentHash: artifactHash,
    availability: 'available',
    storageMode: 'managed',
    managedPath: artifactPath,
    metadata: {
      health: 'ok',
      width: 1,
      height: 1,
      shotId: 'shot-a',
      canvasRevision: 9,
    },
    provenance: {
      source: 'run-output',
      runId: 'run-a',
      nodeRunId: 'node-run-a',
      attemptId: 'attempt-a',
      canvasId: 'canvas-a',
      sourceNodeId: 'image-a',
      shotId: 'shot-a',
      canvasRevision: 9,
    },
  };
  const database = {
    getCanvas: () => document,
    createRunIntent(input) {
      const existing = intentsByKey.get(input.idempotencyKey);
      if (existing) return existing;
      writes += 1;
      const intent = {
        ...input,
        id: `intent-${writes}`,
        entityUid: `uid-intent-${writes}`,
        status: 'accepted',
        runId: null,
        queueRevision: 1,
        dispatchAttempts: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      intentsById.set(intent.id, intent);
      intentsByKey.set(input.idempotencyKey, intent);
      return intent;
    },
    getRunIntent: (id) => intentsById.get(id) || null,
    listRunIntents: () => [...intentsById.values()],
    requestRunIntentCancellation(id, input) {
      const current = intentsById.get(id);
      assert.equal(input.expectedQueueRevision, current.queueRevision);
      const next = { ...current, status: 'cancelled', queueRevision: current.queueRevision + 1, cancelRequestedAt: Date.now() };
      intentsById.set(id, next);
      return next;
    },
    getRunEvidence: options.withEvidence ? () => ({
      ...baseEvidence,
      ...(options.evidence || {}),
    }) : () => null,
    getAsset: options.withEvidence ? () => ({
      ...baseAsset,
      ...(options.asset || {}),
      metadata: {
        ...baseAsset.metadata,
        ...(options.asset?.metadata || {}),
      },
      provenance: {
        ...baseAsset.provenance,
        ...(options.asset?.provenance || {}),
      },
    }) : () => null,
  };
  return {
    database,
    document,
    artifactPath,
    cleanup() {
      if (directory) fs.rmSync(directory, { recursive: true, force: true });
    },
    get providerPosts() { return providerPosts; },
    get writes() { return writes; },
    postProvider() { providerPosts += 1; },
  };
}

const scope = {
  projectId: 'project-local',
  canvasId: 'canvas-a',
  actorId: 'agent-a',
  sessionId: 'session-a',
};

test('run plans omit pricing and still require approval before one durable intent', () => {
  const state = fixture();
  const service = createAgentControlRunService({ database: state.database });
  const plan = service.createPlan({ nodeIds: ['image-a'] }, scope);
  assert.equal(plan.canStart, true);
  assert.equal('cost' in plan, false);
  assert.deepEqual(plan.warnings, []);
  const prepared = service.startPreview(plan.planId, scope);
  assert.equal('cost' in prepared.preview, false);
  assert.equal('budget' in prepared.preview.run, false);
  assert.equal(prepared.preview.providerTransfer.occursNow, false);
  const intent = service.complete(prepared.plan, {
    operationId: 'run-without-pricing-0001',
    actorId: scope.actorId,
  });
  assert.equal('estimatedCostKnown' in intent, false);
  assert.equal('estimatedCost' in intent, false);
  assert.equal('actualCost' in intent, false);
  assert.equal(state.writes, 1);
  assert.equal(state.providerPosts, 0);
});

test('approved run becomes one durable exactly-once intent and can be cancelled', () => {
  const state = fixture();
  const service = createAgentControlRunService({ database: state.database });
  const plan = service.createPlan({ nodeIds: ['image-a'], mode: 'missing-failed-unlocked' }, scope);
  const prepared = service.startPreview(plan.planId, scope);
  assert.equal(prepared.preview.providerTransfer.occursNow, false);
  assert.equal(state.writes, 0);
  assert.equal(state.providerPosts, 0);

  const first = service.complete(prepared.plan, { operationId: 'run-operation-0001', actorId: scope.actorId });
  const replay = service.complete(prepared.plan, { operationId: 'run-operation-0001', actorId: scope.actorId });
  assert.equal(first.id, replay.id);
  assert.equal(first.status, 'accepted');
  assert.equal(state.writes, 1);
  assert.equal(state.providerPosts, 0);

  const cancelled = service.cancel(first.id, first.queueRevision, scope);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.queueRevision, 2);
});

test('completion verification requires succeeded attempts and physically verified output assets', (t) => {
  const state = fixture({ withEvidence: true });
  t.after(() => state.cleanup());
  const verified = verifyCompletionEvidence(state.database, {
    projectId: 'project-local',
    canvasId: 'canvas-a',
    canvasRevision: 9,
    nodeIds: ['image-a'],
    runId: 'run-a',
  });
  assert.equal(verified.verified, true);
  assert.deepEqual(verified.reasons, []);
  assert.equal(verified.assets[0].stored, true);
  assert.equal(verified.assets[0].blobPresent, true);
  assert.equal(verified.assets[0].hashVerified, true);
  assert.equal(verified.assets[0].magicVerified, true);
  assert.equal(verified.assets[0].detectedMimeType, 'image/png');
  assert.equal(verified.assets[0].decodeEvidence, 'indexed-parser-verified');
  assert.equal(verified.assets[0].associationVerified, true);

  const missing = verifyCompletionEvidence(fixture().database, {
    projectId: 'project-local',
    canvasId: 'canvas-a',
    canvasRevision: 9,
    nodeIds: ['image-a'],
    runId: 'run-a',
  });
  assert.equal(missing.verified, false);
  assert.deepEqual(missing.reasons, ['run_evidence_missing']);
});

test('completion verification rejects a database-available asset whose blob is missing', (t) => {
  const state = fixture({ withEvidence: true, omitArtifact: true });
  t.after(() => state.cleanup());
  const result = verifyCompletionEvidence(state.database, {
    projectId: 'project-local',
    canvasId: 'canvas-a',
    canvasRevision: 9,
    nodeIds: ['image-a'],
    runId: 'run-a',
  });
  assert.equal(result.verified, false);
  assert.ok(result.reasons.includes('output_asset_blob_missing:asset-a'));
  assert.equal(result.assets[0].stored, false);
  assert.equal(result.assets[0].blobPresent, false);
});

test('completion verification rejects corrupt magic bytes even when the stored hash matches', (t) => {
  const state = fixture({
    withEvidence: true,
    artifactBytes: Buffer.from('this is not a PNG file', 'utf8'),
  });
  t.after(() => state.cleanup());
  const result = verifyCompletionEvidence(state.database, {
    projectId: 'project-local',
    canvasId: 'canvas-a',
    canvasRevision: 9,
    nodeIds: ['image-a'],
    runId: 'run-a',
  });
  assert.equal(result.verified, false);
  assert.ok(result.reasons.includes('output_asset_corrupt:asset-a'));
  assert.equal(result.assets[0].hashVerified, true);
  assert.equal(result.assets[0].magicVerified, false);
});

test('completion verification rejects physical bytes whose SHA-256 differs from the asset row', (t) => {
  const state = fixture({
    withEvidence: true,
    expectedBytes: Buffer.from('different expected content', 'utf8'),
  });
  t.after(() => state.cleanup());
  const result = verifyCompletionEvidence(state.database, {
    projectId: 'project-local',
    canvasId: 'canvas-a',
    canvasRevision: 9,
    nodeIds: ['image-a'],
    runId: 'run-a',
  });
  assert.equal(result.verified, false);
  assert.ok(result.reasons.includes('output_asset_hash_mismatch:asset-a'));
  assert.equal(result.assets[0].blobPresent, true);
  assert.equal(result.assets[0].hashVerified, false);
});

test('completion verification rejects an artifact associated with a different Story shot', (t) => {
  const state = fixture({
    withEvidence: true,
    asset: {
      metadata: { shotId: 'shot-b' },
      provenance: { shotId: 'shot-b' },
    },
  });
  t.after(() => state.cleanup());
  const result = verifyCompletionEvidence(state.database, {
    projectId: 'project-local',
    canvasId: 'canvas-a',
    canvasRevision: 9,
    nodeIds: ['image-a'],
    runId: 'run-a',
  });
  assert.equal(result.verified, false);
  assert.ok(result.reasons.includes('output_asset_shot_mismatch:asset-a'));
  assert.deepEqual(result.assets[0].expectedShotIds, ['shot-a']);
  assert.deepEqual(result.assets[0].observedShotIds, ['shot-b']);
});

test('completion verification rejects an artifact associated with a different target node', (t) => {
  const state = fixture({
    withEvidence: true,
    asset: {
      provenance: { sourceNodeId: 'image-b' },
    },
  });
  t.after(() => state.cleanup());
  const result = verifyCompletionEvidence(state.database, {
    projectId: 'project-local',
    canvasId: 'canvas-a',
    canvasRevision: 9,
    nodeIds: ['image-a'],
    runId: 'run-a',
  });
  assert.equal(result.verified, false);
  assert.ok(result.reasons.includes('output_asset_node_mismatch:asset-a'));
  assert.equal(result.assets[0].associationVerified, false);
});

test('completion verification rejects run and artifact canvas revision mismatches', (t) => {
  const state = fixture({
    withEvidence: true,
    evidence: {
      run: {
        id: 'run-a',
        projectId: 'project-local',
        canvasId: 'canvas-a',
        canvasRevision: 8,
        status: 'completed',
        createdAt: 1,
        finishedAt: 2,
      },
    },
  });
  t.after(() => state.cleanup());
  const result = verifyCompletionEvidence(state.database, {
    projectId: 'project-local',
    canvasId: 'canvas-a',
    canvasRevision: 9,
    nodeIds: ['image-a'],
    runId: 'run-a',
  });
  assert.equal(result.verified, false);
  assert.ok(result.reasons.includes('run_canvas_revision_mismatch'));
  assert.ok(result.reasons.includes('output_asset_revision_mismatch:asset-a'));
  assert.equal(result.assets[0].associationVerified, false);
});
