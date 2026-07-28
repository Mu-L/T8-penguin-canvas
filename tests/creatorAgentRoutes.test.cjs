'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

const {
  createCreatorAgentRouter,
} = require('../backend/src/routes/creatorAgent.js');
const {
  createCreatorAgentSessionStore,
} = require('../backend/src/services/creatorAgentSessions.js');
const {
  canvasPatchRequestDigest,
} = require('../backend/src/services/canvasPatch.js');

const VALID_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

async function startFixture(t, initialNodes = [], overrides = {}) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 't8-creator-agent-route-'));
  const document = {
    schema: 't8-canvas-document',
    schemaVersion: 2,
    projectId: 'project-local',
    canvasId: 'canvas-a',
    revision: 12,
    nodes: structuredClone(initialNodes),
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  };
  let writes = 0;
  let providerCalls = 0;
  const runs = new Map();
  const nodeRunsByRunId = new Map();
  const intents = new Map();
  const assets = new Map();
  const attemptsByNodeRunId = new Map();
  const runEventsByRunId = new Map();
  const canvasPatches = new Map();
  const database = {
    getCanvas(canvasId) {
      return canvasId === document.canvasId ? structuredClone(document) : null;
    },
    getAsset(assetId) {
      const registered = assets.get(String(assetId));
      if (registered) return structuredClone(registered);
      if (assetId === 'asset-image-a') {
        return {
          id: assetId,
          projectId: 'project-local',
          kind: 'image',
          availability: 'available',
          contentRevision: 1,
        };
      }
      return null;
    },
    getRun(runId) {
      return runs.get(String(runId)) || null;
    },
    listRuns(options = {}) {
      const limit = Math.max(1, Math.min(100, Number(options.limit) || 100));
      return [...runs.values()]
        .filter((run) => (!options.projectId || String(run.projectId) === String(options.projectId))
          && (!options.canvasId || String(run.canvasId) === String(options.canvasId)))
        .sort((left, right) => Number(right.createdAt || 0) - Number(left.createdAt || 0))
        .slice(0, limit)
        .map((run) => structuredClone(run));
    },
    getRunEvents(runId, afterId = 0) {
      return structuredClone((runEventsByRunId.get(String(runId)) || [])
        .filter((event) => Number(event.id) > Math.max(0, Number(afterId) || 0))
        .sort((left, right) => Number(left.id) - Number(right.id)));
    },
    listNodeRuns(runId) {
      return structuredClone(nodeRunsByRunId.get(String(runId)) || []);
    },
    listAttempts(nodeRunId) {
      return structuredClone(attemptsByNodeRunId.get(String(nodeRunId)) || []);
    },
    listCanvasPatches(canvasId, options = {}) {
      if (String(canvasId) !== document.canvasId) return [];
      return [...canvasPatches.values()]
        .filter((patch) => options.includeAllActors === true
          || String(patch.actorId || '') === String(options.actorId || 'local-owner'))
        .map((patch) => {
          const copy = structuredClone(patch);
          if (options.includeRequestDigest !== true) delete copy.requestDigest;
          return copy;
        })
        .sort((left, right) => Number(right.createdAt || 0) - Number(left.createdAt || 0));
    },
    getRunIntent(intentId) {
      return intents.get(String(intentId)) || null;
    },
    getRunEvidence(input = {}) {
      const run = runs.get(String(input.runId || '')) || null;
      if (!run
        || String(run.projectId || '') !== String(input.projectId || '')
        || String(run.canvasId || '') !== String(input.canvasId || '')) return null;
      const nodeRuns = structuredClone(nodeRunsByRunId.get(String(run.id)) || []);
      const attemptsByNodeId = new Map(nodeRuns.map((nodeRun) => [
        String(nodeRun.id),
        structuredClone(attemptsByNodeRunId.get(String(nodeRun.id)) || []),
      ]));
      const attemptCount = [...attemptsByNodeId.values()]
        .reduce((sum, attempts) => sum + attempts.length, 0);
      return {
        run: structuredClone(run),
        totals: { nodeRuns: nodeRuns.length, attempts: attemptCount },
        returned: { nodeRuns: nodeRuns.length, attempts: attemptCount },
        evidenceComplete: true,
        evidenceReasons: [],
        nodeRuns,
        attemptsByNodeId,
      };
    },
    saveCanvas() {
      writes += 1;
      throw new Error('creator planning must not write canvas');
    },
  };
  const sessions = createCreatorAgentSessionStore({ rootDir });
  const app = express();
  app.use(express.json({ limit: '1mb', strict: true }));
  app.use('/api/creator-agent/v1', createCreatorAgentRouter({
    database,
    sessions,
    settingsProvider() {
      providerCalls += 1;
      return {};
    },
    ...(overrides.credentialSettingsProvider ? { credentialSettingsProvider: overrides.credentialSettingsProvider } : {}),
    ...(overrides.runtimeStatusProvider ? { runtimeStatusProvider: overrides.runtimeStatusProvider } : {}),
    ...(overrides.deliveryService ? { deliveryService: overrides.deliveryService } : {}),
    ...(overrides.assetService ? { assetService: overrides.assetService } : {}),
    ...(overrides.approvals ? { approvals: overrides.approvals } : {}),
    ...(overrides.deliveryDrafts ? { deliveryDrafts: overrides.deliveryDrafts } : {}),
    ...(overrides.deliveryApprovals ? { deliveryApprovals: overrides.deliveryApprovals } : {}),
    ...(Object.prototype.hasOwnProperty.call(overrides, 'responseDeltaDelayMs')
      ? { responseDeltaDelayMs: overrides.responseDeltaDelayMs }
      : {}),
    config: {
      DATA_DIR: rootDir,
      SETTINGS_FILE: path.join(rootDir, 'settings.json'),
    },
  }));
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(rootDir, { recursive: true, force: true });
  });
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}/api/creator-agent/v1`;

  async function request(url, init) {
    const response = await fetch(`${base}${url}`, {
      ...init,
      headers: {
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init?.headers || {}),
      },
    });
    return {
      response,
      body: await response.json(),
    };
  }
  return {
    request,
    rootDir,
    registerAsset(asset) {
      assets.set(String(asset.id), structuredClone(asset));
    },
    registerRunEvidence({ run, nodeRuns, intent, registeredAssets = [], attempts = {} }) {
      runs.set(String(run.id), structuredClone(run));
      nodeRunsByRunId.set(String(run.id), structuredClone(nodeRuns));
      if (intent) intents.set(String(intent.id), structuredClone(intent));
      for (const asset of registeredAssets) assets.set(String(asset.id), structuredClone(asset));
      for (const [nodeRunId, nodeRunAttempts] of Object.entries(attempts)) {
        attemptsByNodeRunId.set(String(nodeRunId), structuredClone(nodeRunAttempts));
      }
    },
    registerCanvasPatch(patch) {
      canvasPatches.set(String(patch.patchId), structuredClone(patch));
    },
    setCanvasDocument(input = {}) {
      if (input.revision != null) document.revision = Number(input.revision);
      if (Array.isArray(input.nodes)) document.nodes = structuredClone(input.nodes);
      if (Array.isArray(input.edges)) document.edges = structuredClone(input.edges);
      if (input.viewport) document.viewport = structuredClone(input.viewport);
    },
    appendRunEvent(runId, event) {
      const id = String(runId);
      const current = runEventsByRunId.get(id) || [];
      runEventsByRunId.set(id, [...current, structuredClone(event)]);
    },
    sessions,
    get writes() { return writes; },
    get providerCalls() { return providerCalls; },
  };
}
test('capability graph route exposes one verified node, handler, and runtime contract', async (t) => {
  const fixture = await startFixture(t);
  const capabilities = await fixture.request('/capabilities');
  const graph = await fixture.request('/capability-graph');
  assert.equal(capabilities.response.status, 200);
  assert.equal(graph.response.status, 200);
  assert.equal(graph.body.data.schema, 't8-creative-capability-graph-v1');
  assert.equal(graph.body.data.counts.unknownNodeReferences, 0);
  assert.equal(graph.body.data.counts.handlers, graph.body.data.counts.capabilities);
  assert.equal(
    capabilities.body.data.capabilityGraph.aggregateDigest,
    graph.body.data.aggregateDigest,
  );
  assert.equal(graph.body.data.nodes.some((node) => node.type === 'director-storyboard'), true);
  assert.equal(graph.body.data.runtime.entries.length, graph.body.data.counts.runtimeEntries);
  assert.equal(graph.body.data.counts.missingOperationRisk, 0);
  assert.equal(graph.body.data.readinessSummary.known, graph.body.data.counts.runtimeEntries);
  assert.equal(graph.body.data.readinessSummary.executable, 0);
  assert.equal(graph.body.data.runtime.entries.every((entry) => entry.readiness.executable === false), true);
  assert.equal(capabilities.body.data.capabilities[0].operations[0].riskLevel, 'L0');
  assert.equal(fixture.writes, 0);
  assert.equal(fixture.providerCalls, 0);
});

test('runtime catalog keeps known models visible but only enables credential-ready entries', async (t) => {
  const privateValue = 'route-test-secret-value';
  const fixture = await startFixture(t, [], { credentialSettingsProvider: () => ({ zhenzhenSd2ApiKey: privateValue }) });
  const catalog = await fixture.request('/catalog?projectId=project-local&canvasId=canvas-a');
  assert.equal(catalog.response.status, 200);
  const seedance = catalog.body.data.models.find((item) => item.provider === 'seedance-nz' && item.available !== false);
  const zhenzhen = catalog.body.data.models.find((item) => item.provider === 'zhenzhen' && item.available !== false);
  const action = catalog.body.data.actions.find((item) => item.provider === 'seedance-nz');
  assert.equal(seedance.readiness.executable, true);
  assert.equal(zhenzhen.readiness.executable, false);
  assert.equal(action.readiness.credentialReady, true);
  assert.ok(catalog.body.data.counts.executableModels > 0);
  assert.equal(JSON.stringify(catalog.body).includes(privateValue), false);
  assert.match(catalog.body.data.warning, /目录存在只表示“已知”/);
});
test('empty session and suggestions are provider-free and persist exactly three next actions', async (t) => {
  const fixture = await startFixture(t);
  const suggestions = await fixture.request('/suggestions?nodeCount=0&edgeCount=0');
  assert.equal(suggestions.response.status, 200);
  assert.equal(suggestions.body.data.suggestions.length, 3);
  assert.equal(suggestions.body.data.deterministic, true);
  assert.equal(suggestions.body.data.providerCalls, 0);
  assert.equal(suggestions.body.data.suggestionSet.items.every((item) => item.executable === true), true);
  assert.equal(suggestions.body.data.suggestionSet.items.every((item) => item.blockers.length === 0), true);
  assert.equal(suggestions.body.data.suggestionSet.items.every((item) => (
    item.operationContracts.length > 0
      && item.operationContracts.every((contract) => contract.riskLevel === 'L0'
        && contract.approvalRequired === false)
  )), true);

  const created = await fixture.request('/sessions', {
    method: 'POST',
    body: JSON.stringify({
      projectId: 'project-local',
      canvasId: 'canvas-a',
      context: { nodeCount: 0, edgeCount: 0, canvasTitle: '空白画布' },
    }),
  });
  assert.equal(created.response.status, 201);
  assert.equal(created.body.data.suggestions.length, 3);
  assert.equal(created.body.data.events[0].type, 'session.created');
  assert.equal(created.body.data.suggestionSet.binding.canvasRevision, 12);
  assert.match(created.body.data.suggestionSet.setDigest, /^[a-f0-9]{64}$/);
  assert.equal(fixture.writes, 0);
  assert.equal(fixture.providerCalls, 0);

  const latest = await fixture.request('/sessions?projectId=project-local&canvasId=canvas-a&limit=1');
  assert.equal(latest.response.status, 200);
  assert.equal(latest.body.data.sessions.length, 1);
  assert.equal(latest.body.data.latest.id, created.body.data.id);
  assert.equal(fixture.writes, 0);
  assert.equal(fixture.providerCalls, 0);
});

test('suggestion clicks require the current receipt and stale canvas revisions fail before planning', async (t) => {
  const fixture = await startFixture(t);
  const created = await fixture.request('/sessions', {
    method: 'POST',
    body: JSON.stringify({
      projectId: 'project-local',
      canvasId: 'canvas-a',
      context: { nodeCount: 0, edgeCount: 0, canvasTitle: '建议回执测试' },
    }),
  });
  const session = created.body.data;
  const suggestion = session.suggestionSet.items[0];
  const valid = await fixture.request(`/sessions/${session.id}/messages`, {
    method: 'POST',
    body: JSON.stringify({
      projectId: 'project-local',
      canvasId: 'canvas-a',
      text: suggestion.label,
      context: { nodeCount: 0, edgeCount: 0, canvasTitle: '建议回执测试' },
      suggestion: {
        id: suggestion.id,
        setDigest: session.suggestionSet.setDigest,
      },
    }),
  });
  assert.equal(valid.response.status, 201);
  assert.equal(valid.body.data.userEvent.type, 'user.suggestion');
  assert.equal(valid.body.data.userEvent.payload.suggestion.id, suggestion.id);
  assert.equal(
    valid.body.data.userEvent.payload.suggestion.setDigest,
    session.suggestionSet.setDigest,
  );
  assert.equal(fixture.writes, 0);
  assert.equal(fixture.providerCalls, 0);

  const staleSessionResponse = await fixture.request('/sessions', {
    method: 'POST',
    body: JSON.stringify({
      projectId: 'project-local',
      canvasId: 'canvas-a',
      context: { nodeCount: 0, edgeCount: 0, canvasTitle: '过期建议测试' },
    }),
  });
  const staleSession = staleSessionResponse.body.data;
  const staleSuggestion = staleSession.suggestionSet.items[0];
  const sequenceBefore = fixture.sessions.read(staleSession.id).lastSequence;
  fixture.setCanvasDocument({ revision: 13 });
  const stale = await fixture.request(`/sessions/${staleSession.id}/messages`, {
    method: 'POST',
    body: JSON.stringify({
      projectId: 'project-local',
      canvasId: 'canvas-a',
      text: staleSuggestion.label,
      context: { nodeCount: 0, edgeCount: 0, canvasTitle: '过期建议测试' },
      suggestion: {
        id: staleSuggestion.id,
        setDigest: staleSession.suggestionSet.setDigest,
      },
    }),
  });
  assert.equal(stale.response.status, 409);
  assert.equal(stale.body.code, 'CREATOR_SUGGESTION_STALE');
  assert.match(stale.body.message, /画布、选区或素材已经变化/);
  assert.equal(stale.body.details.staleFields.includes('canvasRevision'), true);
  assert.equal(fixture.sessions.read(staleSession.id).lastSequence, sequenceBefore);
  assert.equal(fixture.writes, 0);
  assert.equal(fixture.providerCalls, 0);
});
test('one sentence creates a previewable Story plan but performs zero writes and provider generation calls', async (t) => {
  const fixture = await startFixture(t);
  const created = await fixture.request('/sessions', {
    method: 'POST',
    body: JSON.stringify({
      projectId: 'project-local',
      canvasId: 'canvas-a',
      context: { nodeCount: 0, edgeCount: 0 },
    }),
  });
  const sessionId = created.body.data.id;

  const planned = await fixture.request(`/sessions/${sessionId}/messages`, {
    method: 'POST',
    body: JSON.stringify({
      projectId: 'project-local',
      canvasId: 'canvas-a',
      text: '把两个朋友在雨夜重逢的故事做成 30 秒竖屏短片',
      context: { nodeCount: 0, edgeCount: 0 },
    }),
  });
  assert.equal(planned.response.status, 201);
  assert.equal(planned.body.data.session.latestPlan.kind, 'story');
  assert.equal(planned.body.data.session.latestPlan.ready, true);
  assert.equal(planned.body.data.session.latestPlan.visibleAssumptions.durationSec, 30);
  assert.equal(planned.body.data.session.latestPlan.visibleAssumptions.ratio, '9:16');
  assert.equal(planned.body.data.session.latestPlan.brief.recipe, 'short-drama');
  const readinessReceipt = planned.body.data.readinessReceipt;
  assert.equal(readinessReceipt.schema, 't8-creator-agent-local-readiness-receipt-v1');
  assert.equal(readinessReceipt.measurement, 'server-monotonic-local-planner');
  assert.equal(readinessReceipt.targetMs, 2000);
  assert.equal(readinessReceipt.withinTarget, true);
  assert.ok(readinessReceipt.localPlanMs >= 0 && readinessReceipt.localPlanMs <= 2000);
  assert.deepEqual(readinessReceipt.sideEffects, {
    providerCalls: 0,
    canvasWrites: 0,
    productionFileWrites: 0,
  });
  assert.deepEqual(planned.body.data.assistantEvent.payload.readinessReceipt, readinessReceipt);
  assert.equal(planned.body.data.session.latestPlan.impact.writesNow, 0);
  assert.equal(planned.body.data.session.latestPlan.impact.providerCallsNow, 0);
  assert.equal(planned.body.data.session.latestPlan.impact.fileWritesNow, 0);
  const productionDocuments = planned.body.data.session.latestPlan.productionDocuments;
  assert.deepEqual(
    productionDocuments.map((item) => item.kind),
    ['production-brief', 'script-doc', 'world-bible', 'character-bible', 'asset-needs', 'shot-list', 'audio-plan', 'storyboard', 'prompt-pack', 'candidate-review', 'edit-decision-list', 'qc-report', 'delivery-manifest'],
  );
  assert.equal(productionDocuments.every((item) => item.revision === 1), true);
  assert.equal(productionDocuments.every((item) => item.status === 'draft'), true);
  assert.equal(productionDocuments.find((item) => item.kind === 'script-doc').content.sourceText,
    '把两个朋友在雨夜重逢的故事做成 30 秒竖屏短片');
  assert.deepEqual(productionDocuments.find((item) => item.kind === 'world-bible').content.characters, []);
  const currentPlan = planned.body.data.session.latestPlan;
  const derivedDocuments = productionDocuments.filter((item) => (
    item.kind === 'character-bible'
      || item.kind === 'asset-needs'
      || item.kind === 'shot-list'
      || item.kind === 'audio-plan'
      || item.kind === 'storyboard'
      || item.kind === 'prompt-pack'
      || item.kind === 'candidate-review'
      || item.kind === 'edit-decision-list'
      || item.kind === 'qc-report'
      || item.kind === 'delivery-manifest'
  ));
  const sourceBlocked = await fixture.request(`/sessions/${sessionId}/production-documents/confirm`, {
    method: 'POST',
    body: JSON.stringify({
      projectId: 'project-local',
      canvasId: 'canvas-a',
      planId: currentPlan.planId,
      planDigest: currentPlan.planDigest,
      documents: derivedDocuments.map((item) => ({
        documentId: item.id,
        versionId: item.versionId,
        contentDigest: item.contentDigest,
      })),
    }),
  });
  assert.equal(sourceBlocked.response.status, 409);
  assert.equal(sourceBlocked.body.code, 'CREATOR_PRODUCTION_DOCUMENT_SOURCE_UNCONFIRMED');
  assert.match(sourceBlocked.body.message, /先确认.*来源|一次确认/);
  assert.equal(sourceBlocked.body.data, undefined);
  assert.equal(fixture.writes, 0);
  assert.equal(fixture.providerCalls, 0);
  const confirmationBody = {
    projectId: 'project-local',
    canvasId: 'canvas-a',
    planId: currentPlan.planId,
    planDigest: currentPlan.planDigest,
    documents: productionDocuments.map((item) => ({
      documentId: item.id,
      versionId: item.versionId,
      contentDigest: item.contentDigest,
    })),
  };
  const confirmed = await fixture.request(`/sessions/${sessionId}/production-documents/confirm`, {
    method: 'POST',
    body: JSON.stringify(confirmationBody),
  });
  assert.equal(confirmed.response.status, 201);
  assert.equal(confirmed.body.data.confirmations.length, 13);
  assert.equal(confirmed.body.data.session.productionDocumentConfirmations.length, 13);
  assert.equal(confirmed.body.data.session.events.at(-1).type, 'production-documents.confirmed');
  assert.equal(confirmed.body.data.session.events.at(-1).payload.providerCalls, 0);
  assert.equal(confirmed.body.data.session.events.at(-1).payload.canvasWrites, 0);
  const confirmationSequence = confirmed.body.data.session.lastSequence;
  const duplicateConfirmation = await fixture.request(`/sessions/${sessionId}/production-documents/confirm`, {
    method: 'POST',
    body: JSON.stringify(confirmationBody),
  });
  assert.equal(duplicateConfirmation.response.status, 200);
  assert.equal(duplicateConfirmation.body.data.duplicate, true);
  assert.equal(duplicateConfirmation.body.data.session.lastSequence, confirmationSequence);
  const modelReceipt = planned.body.data.session.latestPlan.modelDecisionReceipt;
  assert.equal(modelReceipt.schema, 't8-model-decision-receipt-v1');
  assert.equal(modelReceipt.mode, 'smart');
  assert.equal(modelReceipt.providerCalls, 0);
  assert.equal(modelReceipt.canvasWrites, 0);
  assert.equal(modelReceipt.decisions.filter((item) => item.required).length, 4);
  assert.equal(modelReceipt.fallbackPolicy.silentProviderFallback, false);
  assert.doesNotMatch(JSON.stringify(modelReceipt), /api[_-]?key|bearer|sk-[A-Za-z0-9_-]{8,}/i);
  assert.equal(planned.body.data.session.suggestions.length, 3);
  assert.equal(fixture.writes, 0);
  assert.equal(fixture.providerCalls, 0);

  const planId = planned.body.data.session.latestPlan.planId;
  const patch = await fixture.request(
    `/sessions/${sessionId}/plans/${planId}/patch?projectId=project-local&canvasId=canvas-a`,
  );
  assert.equal(patch.response.status, 200);
  assert.equal(patch.body.data.patch.schema, 't8-canvas-patch-v1');
  assert.equal(patch.body.data.patch.baseRevision, 12);
  assert.equal(patch.body.data.patch.requiresConfirmation, true);
  assert.ok(patch.body.data.patch.operations.length > 0);
  const revised = await fixture.request(`/sessions/${sessionId}/messages`, {
    method: 'POST',
    body: JSON.stringify({
      projectId: 'project-local',
      canvasId: 'canvas-a',
      kind: 'story',
      text: '改成两个朋友在雪夜重逢，其他要求不变',
      ratio: '9:16',
      duration: 30,
      context: { nodeCount: 0, edgeCount: 0 },
    }),
  });
  assert.equal(revised.response.status, 201);
  const revisedDocuments = revised.body.data.session.latestPlan.productionDocuments;
  assert.equal(revisedDocuments.find((item) => item.kind === 'production-brief').revision, 2);
  assert.equal(revisedDocuments.find((item) => item.kind === 'script-doc').revision, 2);
  assert.equal(revisedDocuments.find((item) => item.kind === 'world-bible').revision, 2);
  assert.equal(revisedDocuments.every((item) => item.status === 'draft'), true);
  assert.equal(revisedDocuments.every((item) => item.changeSummary?.changedFields?.length > 0), true);
  const staleConfirmation = await fixture.request(`/sessions/${sessionId}/production-documents/confirm`, {
    method: 'POST',
    body: JSON.stringify(confirmationBody),
  });
  assert.equal(staleConfirmation.response.status, 409);
  assert.equal(staleConfirmation.body.code, 'CREATOR_PRODUCTION_DOCUMENT_STALE');
  assert.match(staleConfirmation.body.message, /已有新版本|新版本/);
  const planEvents = revised.body.data.session.events.filter((event) => event.type === 'assistant.plan');
  assert.equal(planEvents.length, 2);
  assert.equal(
    planEvents[0].payload.plan.productionDocuments.find((item) => item.kind === 'script-doc').revision,
    1,
  );
  assert.equal(
    planEvents[0].payload.plan.productionDocuments.find((item) => item.kind === 'script-doc').content.sourceText,
    '把两个朋友在雨夜重逢的故事做成 30 秒竖屏短片',
  );
  assert.match(
    planEvents[1].payload.plan.productionDocuments.find((item) => item.kind === 'script-doc').content.sourceText,
    /雪夜重逢.*其他要求不变/,
  );
  assert.equal(fixture.writes, 0);
  assert.equal(fixture.providerCalls, 0);
});

test('Creator route returns deterministic source-mapped script structure without provider calls', async (t) => {
  const fixture = await startFixture(t);
  const created = await fixture.request('/sessions', {
    method: 'POST',
    body: JSON.stringify({
      projectId: 'project-local',
      canvasId: 'canvas-a',
      context: { nodeCount: 0, edgeCount: 0 },
    }),
  });
  const sourceText = [
    'Scene：The Alley',
    'Characters：萌萌，罂瑶',
    '【镜头一｜建立环境】',
    '雨夜的悉尼唐人街后巷。',
    '【镜头二｜建立人物】',
    '电梯门缓缓打开。萌萌独自走出。',
  ].join('\n');
  const planned = await fixture.request(`/sessions/${created.body.data.id}/messages`, {
    method: 'POST',
    body: JSON.stringify({
      projectId: 'project-local',
      canvasId: 'canvas-a',
      kind: 'story',
      text: sourceText,
      ratio: '16:9',
      duration: 20,
      context: { nodeCount: 0, edgeCount: 0 },
    }),
  });
  assert.equal(planned.response.status, 201);
  const script = planned.body.data.session.latestPlan.productionDocuments
    .find((item) => item.kind === 'script-doc');
  assert.equal(script.content.scriptAnalysis.schema, 't8-creator-script-analysis-v1');
  assert.equal(script.content.scriptAnalysis.status, 'source-structured');
  assert.equal(script.content.scriptAnalysis.counts.scenes, 1);
  assert.equal(script.content.scriptAnalysis.counts.shots, 2);
  assert.deepEqual(script.content.shots.map((item) => item.title), ['建立环境', '建立人物']);
  assert.equal(script.content.scriptAnalysis.providerCalls, 0);
  assert.equal(script.content.scriptAnalysis.inferredFacts, 0);
  assert.match(script.content.editingGuidance, /没有推断/);
  const characterBible = planned.body.data.session.latestPlan.productionDocuments
    .find((item) => item.kind === 'character-bible');
  const assetNeeds = planned.body.data.session.latestPlan.productionDocuments
    .find((item) => item.kind === 'asset-needs');
  assert.deepEqual(characterBible.content.characters.map((item) => item.name), ['萌萌', '罂瑶']);
  assert.equal(characterBible.content.derivation.sourceVersionId, script.versionId);
  assert.deepEqual(assetNeeds.content.counts, {
    total: 3,
    characters: 2,
    locations: 1,
  });
  assert.equal(assetNeeds.content.generationScope, 'none');
  const shotList = planned.body.data.session.latestPlan.productionDocuments
    .find((item) => item.kind === 'shot-list');
  assert.equal(shotList.content.status, 'source-proposed');
  assert.deepEqual(shotList.content.counts, { total: 2, scenes: 1, shots: 2 });
  assert.deepEqual(shotList.content.shots.map((item) => item.title), ['建立环境', '建立人物']);
  assert.equal(shotList.content.shots[0].sourceEvidence.lineStart, 3);
  assert.equal(shotList.content.shots[1].sourceEvidence.lineEnd, 6);
  assert.equal(shotList.content.shots.every((item) => item.durationSec === null), true);
  assert.equal(shotList.content.derivation.sourceVersionId, script.versionId);
  assert.equal(shotList.content.derivation.providerCalls, 0);
  assert.equal(shotList.content.generationScope, 'none');
  const storyboard = planned.body.data.session.latestPlan.productionDocuments
    .find((item) => item.kind === 'storyboard');
  assert.equal(storyboard.content.status, 'source-proposed');
  assert.deepEqual(storyboard.content.counts, { total: 2, ready: 0, missing: 2 });
  assert.deepEqual(storyboard.content.frames.map((item) => item.title), ['建立环境', '建立人物']);
  assert.equal(storyboard.content.frames[0].sourceEvidence.lineStart, 3);
  assert.equal(storyboard.content.frames[1].sourceEvidence.lineEnd, 6);
  assert.equal(storyboard.content.frames.every((item) => (
    item.frameStatus === 'missing'
      && item.candidateIds.length === 0
      && item.selectedCandidateId === null
      && item.assetId === null
      && item.acceptedAt === null
      && item.locked === false
      && item.prompt === ''
      && item.composition === ''
  )), true);
  assert.equal(storyboard.content.derivation.sourceVersionId, shotList.versionId);
  assert.equal(storyboard.content.adoptionPolicy, 'explicit-only');
  assert.equal(storyboard.content.generationScope, 'none');
  const audioPlan = planned.body.data.session.latestPlan.productionDocuments
    .find((item) => item.kind === 'audio-plan');
  assert.equal(audioPlan.content.status, 'needs-explicit-audio-cues');
  assert.deepEqual(audioPlan.content.counts, {
    total: 0,
    dialogue: 0,
    voiceover: 0,
    music: 0,
    ambience: 0,
    sfx: 0,
  });
  assert.deepEqual(audioPlan.content.items, []);
  assert.equal(audioPlan.content.derivation.sourceDocumentId, shotList.id);
  assert.equal(audioPlan.content.derivation.sourceVersionId, shotList.versionId);
  assert.equal(audioPlan.content.derivation.providerCalls, 0);
  assert.equal(audioPlan.content.generationScope, 'none');
  const promptPack = planned.body.data.session.latestPlan.productionDocuments
    .find((item) => item.kind === 'prompt-pack');
  assert.equal(promptPack.content.status, 'source-proposed');
  assert.deepEqual(promptPack.content.counts, { total: 2, drafts: 2, reviewed: 0 });
  assert.deepEqual(promptPack.content.prompts.map((item) => item.title), ['建立环境', '建立人物']);
  assert.equal(promptPack.content.prompts[0].positivePrompt, storyboard.content.frames[0].sourceEvidence.sourceText);
  assert.equal(promptPack.content.prompts.every((item) => (
    item.promptStatus === 'source-draft'
      && item.negativePrompt === ''
      && item.motionPrompt === ''
      && item.audioPrompt === ''
      && item.referenceAssetIds.length === 0
      && item.modelSelection.image === null
      && item.modelSelection.video === null
      && item.modelSelection.audio === null
      && item.creatorReviewed === false
      && item.locked === false
      && item.unresolved.length === 5
  )), true);
  assert.equal(promptPack.content.derivation.sourceVersionId, storyboard.versionId);
  assert.equal(promptPack.content.reviewPolicy, 'explicit-confirmation');
  assert.equal(promptPack.content.generationScope, 'none');
  const candidateReview = planned.body.data.session.latestPlan.productionDocuments
    .find((item) => item.kind === 'candidate-review');
  const editDecisionList = planned.body.data.session.latestPlan.productionDocuments
    .find((item) => item.kind === 'edit-decision-list');
  const qcReport = planned.body.data.session.latestPlan.productionDocuments
    .find((item) => item.kind === 'qc-report');
  assert.equal(editDecisionList.content.status, 'awaiting-adopted-video');
  const deliveryManifest = planned.body.data.session.latestPlan.productionDocuments
    .find((item) => item.kind === 'delivery-manifest');
  assert.deepEqual(editDecisionList.content.counts, {
    total: 0,
    ready: 0,
    missingDuration: 0,
    missingShots: 2,
    blocked: 0,
  });
  assert.deepEqual(editDecisionList.content.sequence, []);
  assert.equal(editDecisionList.content.derivation.sourceDocumentId, candidateReview.id);
  assert.equal(editDecisionList.content.timeline.timingStatus, 'empty');
  assert.equal(qcReport.content.status, 'awaiting-edit-decision-list');
  assert.deepEqual(qcReport.content.counts, {
    total: 0, pass: 0, fail: 0, unknown: 0, checks: 0,
  });
  assert.deepEqual(qcReport.content.qcItems, []);
  assert.equal(qcReport.content.derivation.sourceDocumentId, editDecisionList.id);
  assert.equal(qcReport.content.derivation.documentProviderCalls, 0);
  assert.equal(fixture.writes, 0);
  assert.equal(fixture.providerCalls, 0);
  assert.equal(deliveryManifest.content.status, 'awaiting-qc-report');
  assert.deepEqual(deliveryManifest.content.counts, {
    total: 0, included: 0, blocked: 0, awaiting: 0, packageFiles: 0,
    licenseKnown: 0, licenseUnknown: 0,
  });
  assert.deepEqual(deliveryManifest.content.deliverables, []);
  assert.equal(deliveryManifest.content.derivation.sourceDocumentId, qcReport.id);
  assert.equal(deliveryManifest.content.derivation.documentDeliveryWrites, 0);
});

test('fixed model stays exact when ready and fails closed without silent fallback when blocked', async (t) => {
  const privateValue = 'route-model-secret-value';
  const fixture = await startFixture(t, [], {
    credentialSettingsProvider: () => ({ zhenzhenSd2ApiKey: privateValue }),
  });
  const catalog = await fixture.request('/catalog?projectId=project-local&canvasId=canvas-a');
  const readyImage = catalog.body.data.models.find((item) => (
    item.kind === 'image' && item.provider === 'seedance-nz' && item.readiness.executable === true
  ));
  const blockedImage = catalog.body.data.models.find((item) => (
    item.kind === 'image' && item.provider === 'zhenzhen' && item.readiness.executable === false
  ));
  const settingsReadsAfterCatalog = fixture.providerCalls;
  assert.ok(readyImage);
  assert.ok(blockedImage);

  const readySession = await fixture.request('/sessions', {
    method: 'POST',
    body: JSON.stringify({
      projectId: 'project-local',
      canvasId: 'canvas-a',
      context: { nodeCount: 0, edgeCount: 0 },
    }),
  });
  const fixedReady = await fixture.request(`/sessions/${readySession.body.data.id}/messages`, {
    method: 'POST',
    body: JSON.stringify({
      projectId: 'project-local',
      canvasId: 'canvas-a',
      kind: 'image',
      text: '生成一张雨夜电影感海报',
      modelPreferences: {
        image: { provider: readyImage.provider, model: readyImage.model },
      },
    }),
  });
  assert.equal(fixedReady.response.status, 201);
  const readyReceipt = fixedReady.body.data.session.latestPlan.modelDecisionReceipt;
  assert.equal(readyReceipt.mode, 'fixed');
  assert.equal(readyReceipt.ready, true);
  assert.equal(readyReceipt.decisions[0].selected.provider, readyImage.provider);
  assert.equal(readyReceipt.decisions[0].selected.model, readyImage.model);
  assert.equal(JSON.stringify(fixedReady.body).includes(privateValue), false);

  const blockedSession = await fixture.request('/sessions', {
    method: 'POST',
    body: JSON.stringify({
      projectId: 'project-local',
      canvasId: 'canvas-a',
      context: { nodeCount: 0, edgeCount: 0 },
    }),
  });
  const fixedBlocked = await fixture.request(`/sessions/${blockedSession.body.data.id}/messages`, {
    method: 'POST',
    body: JSON.stringify({
      projectId: 'project-local',
      canvasId: 'canvas-a',
      kind: 'image',
      text: '生成一张雨夜电影感海报',
      modelPreferences: {
        image: { provider: blockedImage.provider, model: blockedImage.model },
      },
    }),
  });
  assert.equal(fixedBlocked.response.status, 409);
  assert.equal(fixedBlocked.body.code, 'CREATOR_MODEL_RUNTIME_NOT_READY');
  assert.match(fixedBlocked.body.message, /没有自动切换平台或模型/);
  assert.equal(fixture.writes, 0);
  assert.equal(fixture.providerCalls, settingsReadsAfterCatalog);
});

test('one sentence streams a durable assistant reply and rejects overlapping submissions', async (t) => {
  const fixture = await startFixture(t, [], { responseDeltaDelayMs: 35 });
  const created = await fixture.request('/sessions', {
    method: 'POST',
    body: JSON.stringify({
      projectId: 'project-local',
      canvasId: 'canvas-a',
      context: { nodeCount: 0, edgeCount: 0, canvasTitle: '流式短片' },
    }),
  });
  const sessionId = created.body.data.id;
  const messageBody = {
    projectId: 'project-local',
    canvasId: 'canvas-a',
    text: '一句话做一个 30 秒雨夜追逐短片',
    stream: true,
    context: { nodeCount: 0, edgeCount: 0 },
  };
  const firstPromise = fixture.request(`/sessions/${sessionId}/messages`, {
    method: 'POST',
    body: JSON.stringify(messageBody),
  });
  await new Promise((resolve) => setTimeout(resolve, 15));
  const overlapping = await fixture.request(`/sessions/${sessionId}/messages`, {
    method: 'POST',
    body: JSON.stringify(messageBody),
  });
  assert.equal(overlapping.response.status, 409);
  assert.equal(overlapping.body.code, 'CREATOR_RESPONSE_IN_PROGRESS');

  const first = await firstPromise;
  assert.equal(first.response.status, 201);
  assert.equal(first.body.data.stream.durable, true);
  assert.ok(first.body.data.stream.chunkCount > 1);
  const responseId = first.body.data.stream.responseId;
  const responseEvents = first.body.data.session.events
    .filter((event) => event.payload?.responseId === responseId);
  assert.equal(responseEvents[0].type, 'assistant.response.started');
  assert.equal(responseEvents.at(-1).type, 'assistant.response.completed');
  assert.equal(responseEvents.filter((event) => event.type === 'assistant.response.delta').length,
    first.body.data.stream.chunkCount);
  assert.equal(responseEvents.filter((event) => event.type === 'assistant.response.delta')
    .map((event) => event.payload.delta).join(''), responseEvents.at(-1).payload.text);
  assert.equal(first.body.data.session.latestPlan.planId, first.body.data.assistantEvent.payload.plan.planId);
  assert.equal(fixture.writes, 0);
  assert.equal(fixture.providerCalls, 0);

  const resumed = await fetch(
    `http://127.0.0.1:${new URL(first.response.url).port}`
      + `/api/creator-agent/v1/sessions/${sessionId}/events`
      + `?projectId=project-local&canvasId=canvas-a&after=${responseEvents[0].sequence}`,
    { headers: { Accept: 'text/event-stream' } },
  );
  assert.equal(resumed.status, 200);
  const reader = resumed.body.getReader();
  const decoder = new TextDecoder();
  let payload = '';
  while (!payload.includes('assistant.response.completed')) {
    const next = await reader.read();
    if (next.done) break;
    payload += decoder.decode(next.value, { stream: true });
  }
  await reader.cancel();
  assert.match(payload, /assistant\.response\.delta/);
  assert.match(payload, /assistant\.response\.completed/);
});

test('stopping a reply creates one local terminal event and leaves remote tasks untouched', async (t) => {
  const fixture = await startFixture(t, [], { responseDeltaDelayMs: 60 });
  const created = await fixture.request('/sessions', {
    method: 'POST',
    body: JSON.stringify({
      projectId: 'project-local',
      canvasId: 'canvas-a',
      context: { nodeCount: 0, edgeCount: 0, canvasTitle: '停止回复验收' },
    }),
  });
  const sessionId = created.body.data.id;
  const clientRequestId = 'creator-stop-route-0001';
  const messageBody = {
    projectId: 'project-local',
    canvasId: 'canvas-a',
    clientRequestId,
    text: '一句话做一个 30 秒雨夜追逐短片',
    stream: true,
    context: { nodeCount: 0, edgeCount: 0 },
  };
  const firstPromise = fixture.request(`/sessions/${sessionId}/messages`, {
    method: 'POST',
    body: JSON.stringify(messageBody),
  });
  await new Promise((resolve) => setTimeout(resolve, 80));
  const inProgress = await fixture.request(
    `/sessions/${sessionId}/messages/${clientRequestId}`
      + '?projectId=project-local&canvasId=canvas-a',
  );
  assert.equal(inProgress.body.data.status, 'in-progress');
  const responseId = inProgress.body.data.responseId;
  assert.ok(responseId);

  const stopped = await fixture.request(
    `/sessions/${sessionId}/responses/${responseId}/stop`,
    {
      method: 'POST',
      body: JSON.stringify({
        projectId: 'project-local',
        canvasId: 'canvas-a',
      }),
    },
  );
  assert.equal(stopped.response.status, 200);
  assert.equal(stopped.body.data.schema, 't8-creator-response-stop-v1');
  assert.equal(stopped.body.data.status, 'stopped');
  assert.equal(stopped.body.data.remoteTasksAffected, 0);
  assert.match(stopped.body.message, /远端生成任务没有被取消/);

  const first = await firstPromise;
  assert.equal(first.response.status, 200);
  assert.equal(first.body.data.request.status, 'stopped');
  assert.equal(first.body.data.stream.stopped, true);
  assert.equal(first.body.data.stream.remoteTasksAffected, 0);
  assert.equal(first.body.data.session.latestPlan, null);
  const responseEvents = first.body.data.session.events
    .filter((event) => event.payload?.responseId === responseId);
  assert.equal(responseEvents.filter((event) => event.type === 'assistant.response.started').length, 1);
  assert.equal(responseEvents.filter((event) => event.type === 'assistant.response.stopped').length, 1);
  assert.equal(responseEvents.filter((event) => event.type === 'assistant.response.completed').length, 0);
  assert.equal(responseEvents.filter((event) => event.type === 'assistant.response.failed').length, 0);
  assert.ok(
    responseEvents.filter((event) => event.type === 'assistant.response.delta').length
      < first.body.data.stream.chunkCount,
  );

  const duplicateStop = await fixture.request(
    `/sessions/${sessionId}/responses/${responseId}/stop`,
    {
      method: 'POST',
      body: JSON.stringify({
        projectId: 'project-local',
        canvasId: 'canvas-a',
      }),
    },
  );
  assert.equal(duplicateStop.body.data.status, 'stopped');
  assert.equal(duplicateStop.body.data.duplicate, true);
  assert.equal(duplicateStop.body.data.assistantEvent.eventId, stopped.body.data.assistantEvent.eventId);

  const retry = await fixture.request(`/sessions/${sessionId}/messages`, {
    method: 'POST',
    body: JSON.stringify({
      ...messageBody,
      clientRequestId: 'creator-stop-route-0002',
      text: '继续，但先只整理三步计划',
    }),
  });
  assert.equal(retry.response.status, 201);
  assert.equal(retry.body.data.request.status, 'completed');
  assert.equal(retry.body.data.session.latestPlan.planId, retry.body.data.assistantEvent.payload.plan.planId);
  assert.equal(fixture.writes, 0);
  assert.equal(fixture.providerCalls, 0);
});

test('lost message responses recover the same stream and never duplicate plans or provider calls', async (t) => {
  const fixture = await startFixture(t, [], { responseDeltaDelayMs: 35 });
  const created = await fixture.request('/sessions', {
    method: 'POST',
    body: JSON.stringify({
      projectId: 'project-local',
      canvasId: 'canvas-a',
      context: { nodeCount: 0, edgeCount: 0, canvasTitle: '断线恢复短片' },
    }),
  });
  const sessionId = created.body.data.id;
  const clientRequestId = 'creator-network-recovery-0001';
  const messageBody = {
    projectId: 'project-local',
    canvasId: 'canvas-a',
    clientRequestId,
    text: '一句话做一个 30 秒雨夜追逐短片',
    stream: true,
    context: { nodeCount: 0, edgeCount: 0 },
  };

  const firstPromise = fixture.request(`/sessions/${sessionId}/messages`, {
    method: 'POST',
    body: JSON.stringify(messageBody),
  });
  await new Promise((resolve) => setTimeout(resolve, 15));
  const recoveredWhileStreaming = await fixture.request(`/sessions/${sessionId}/messages`, {
    method: 'POST',
    body: JSON.stringify(messageBody),
  });
  assert.equal(recoveredWhileStreaming.response.status, 202);
  assert.equal(recoveredWhileStreaming.body.data.request.clientRequestId, clientRequestId);
  assert.equal(recoveredWhileStreaming.body.data.request.status, 'in-progress');
  assert.equal(recoveredWhileStreaming.body.data.request.duplicate, true);
  assert.equal(recoveredWhileStreaming.body.data.stream.recovering, true);
  const responseId = recoveredWhileStreaming.body.data.stream.responseId;
  assert.ok(responseId);

  const unrelated = await fixture.request(`/sessions/${sessionId}/messages`, {
    method: 'POST',
    body: JSON.stringify({
      ...messageBody,
      clientRequestId: 'creator-network-recovery-0002',
    }),
  });
  assert.equal(unrelated.response.status, 409);
  assert.equal(unrelated.body.code, 'CREATOR_RESPONSE_IN_PROGRESS');

  const first = await firstPromise;
  assert.equal(first.response.status, 201);
  assert.equal(first.body.data.stream.responseId, responseId);
  const exactRetry = await fixture.request(`/sessions/${sessionId}/messages`, {
    method: 'POST',
    body: JSON.stringify(messageBody),
  });
  assert.equal(exactRetry.response.status, 200);
  assert.equal(exactRetry.body.data.request.status, 'completed');
  assert.equal(exactRetry.body.data.request.duplicate, true);
  assert.equal(exactRetry.body.data.stream.responseId, responseId);
  assert.equal(
    exactRetry.body.data.assistantEvent.payload.plan.planId,
    first.body.data.assistantEvent.payload.plan.planId,
  );

  const recoveredById = await fixture.request(
    `/sessions/${sessionId}/messages/${clientRequestId}`
      + '?projectId=project-local&canvasId=canvas-a',
  );
  assert.equal(recoveredById.response.status, 200);
  assert.equal(recoveredById.body.data.status, 'completed');
  assert.equal(recoveredById.body.data.responseId, responseId);

  const conflict = await fixture.request(`/sessions/${sessionId}/messages`, {
    method: 'POST',
    body: JSON.stringify({
      ...messageBody,
      text: '同一个恢复编号却换成另一条要求',
    }),
  });
  assert.equal(conflict.response.status, 409);
  assert.equal(conflict.body.code, 'CREATOR_MESSAGE_IDEMPOTENCY_CONFLICT');

  const persisted = fixture.sessions.read(sessionId);
  assert.equal(persisted.events.filter((event) => (
    event.type === 'user.message'
      && event.payload?.clientRequestId === clientRequestId
  )).length, 1);
  assert.equal(persisted.events.filter((event) => (
    event.type === 'assistant.response.started'
      && event.payload?.clientRequestId === clientRequestId
  )).length, 1);
  assert.equal(persisted.events.filter((event) => (
    event.type === 'assistant.response.completed'
      && event.payload?.clientRequestId === clientRequestId
  )).length, 1);
  assert.equal(fixture.writes, 0);
  assert.equal(fixture.providerCalls, 0);
});

test('linked Run progress resumes from the durable database cursor without duplicate lifecycle cards', async (t) => {
  const fixture = await startFixture(t);
  const created = await fixture.request('/sessions', {
    method: 'POST',
    body: JSON.stringify({
      projectId: 'project-local',
      canvasId: 'canvas-a',
      context: { nodeCount: 1, edgeCount: 0 },
    }),
  });
  const sessionId = created.body.data.id;
  fixture.registerRunEvidence({
    run: {
      id: 'run-cursor-route',
      projectId: 'project-local',
      canvasId: 'canvas-a',
      canvasRevision: 12,
      status: 'running',
      summary: {},
    },
    nodeRuns: [],
  });
  const linked = fixture.sessions.appendLifecycle(sessionId, 'run.linked', {
    planId: 'plan-cursor-route',
    planDigest: 'c'.repeat(64),
    patchId: 'patch-cursor-route',
    runId: 'run-cursor-route',
    runIntentId: '',
    matchedNodeIds: ['node-a'],
  });
  fixture.appendRunEvent('run-cursor-route', {
    id: 71,
    entityUid: 'event-run-running',
    runId: 'run-cursor-route',
    nodeRunId: null,
    type: 'run.running',
    payload: { status: 'running', progress: 10 },
    createdAt: 71,
  });

  const firstStream = await fetch(
    `http://127.0.0.1:${new URL(created.response.url).port}`
      + `/api/creator-agent/v1/sessions/${sessionId}/events`
      + `?projectId=project-local&canvasId=canvas-a&after=${linked.lastSequence}`,
    { headers: { Accept: 'text/event-stream' } },
  );
  const firstReader = firstStream.body.getReader();
  const decoder = new TextDecoder();
  let firstPayload = '';
  while (!firstPayload.includes('run.running')) {
    const next = await firstReader.read();
    if (next.done) break;
    firstPayload += decoder.decode(next.value, { stream: true });
  }
  await firstReader.cancel();
  assert.match(firstPayload, /run\.running/);

  const afterFirst = await fixture.request(
    `/sessions/${sessionId}?projectId=project-local&canvasId=canvas-a`,
  );
  const firstRunEvent = afterFirst.body.data.events.find((event) => (
    event.type === 'run.event' && event.payload.sourceEventId === 71
  ));
  assert.ok(firstRunEvent);
  assert.equal(afterFirst.body.data.runEventCursors['run-cursor-route'], 71);

  fixture.appendRunEvent('run-cursor-route', {
    id: 79,
    entityUid: 'event-node-succeeded',
    runId: 'run-cursor-route',
    nodeRunId: 'node-run-route',
    type: 'node.succeeded',
    payload: { status: 'succeeded', nodeId: 'node-a', outputRefs: ['asset-a'] },
    createdAt: 79,
  });
  const resumed = await fetch(
    `http://127.0.0.1:${new URL(created.response.url).port}`
      + `/api/creator-agent/v1/sessions/${sessionId}/events`
      + `?projectId=project-local&canvasId=canvas-a&after=${firstRunEvent.sequence}`,
    { headers: { Accept: 'text/event-stream', 'Last-Event-ID': String(firstRunEvent.sequence) } },
  );
  const resumedReader = resumed.body.getReader();
  let resumedPayload = '';
  while (!resumedPayload.includes('node.succeeded')) {
    const next = await resumedReader.read();
    if (next.done) break;
    resumedPayload += decoder.decode(next.value, { stream: true });
  }
  await resumedReader.cancel();
  assert.match(resumedPayload, /node\.succeeded/);
  const final = await fixture.request(`/sessions/${sessionId}?projectId=project-local&canvasId=canvas-a`);
  assert.equal(final.body.data.runEventCursors['run-cursor-route'], 79);
  assert.equal(final.body.data.events.filter((event) => event.type === 'run.event').length, 2);
  assert.equal(fixture.writes, 0);
  assert.equal(fixture.providerCalls, 0);
});

test('one sentence infers a locked TVC recipe without requiring the creator to learn templates', async (t) => {
  const fixture = await startFixture(t);
  const created = await fixture.request('/sessions', {
    method: 'POST',
    body: JSON.stringify({
      projectId: 'project-local',
      canvasId: 'canvas-a',
      context: { nodeCount: 0, edgeCount: 0 },
    }),
  });
  const planned = await fixture.request(`/sessions/${created.body.data.id}/messages`, {
    method: 'POST',
    body: JSON.stringify({
      projectId: 'project-local',
      canvasId: 'canvas-a',
      text: '为透明折叠伞做 20 秒竖屏品牌广告片',
      context: { nodeCount: 0, edgeCount: 0 },
    }),
  });
  assert.equal(planned.response.status, 201);
  assert.equal(planned.body.data.session.latestPlan.kind, 'story');
  assert.equal(planned.body.data.session.latestPlan.brief.recipe, 'tvc');
  assert.equal(planned.body.data.session.latestPlan.visibleAssumptions.durationSec, 20);
  assert.equal(planned.body.data.session.latestPlan.visibleAssumptions.ratio, '9:16');
  assert.deepEqual(
    planned.body.data.session.latestPlan.brief.locks,
    ['productShape', 'logo', 'prompt'],
  );
  assert.equal(fixture.writes, 0);
  assert.equal(fixture.providerCalls, 0);
});

test('candidate compare and iterate plans stay in one Creator Session and never bypass preview', async (t) => {
  const fixture = await startFixture(t, [{
    id: 'candidate-a',
    type: 'image',
    position: { x: 40, y: 80 },
    data: {
      prompt: '雨夜侦探',
      imageUrl: '/outputs/candidate-a.png',
      status: 'succeeded',
      creativeState: {
        schema: 't8-creative-state-v1',
        groupId: 'candidate-group-a',
        candidateId: 'candidate-a',
        candidateIndex: 1,
        candidateCount: 1,
        profile: 'balanced',
        template: 'short-drama',
        accepted: false,
        activeBranchId: 'main',
        locks: {
          identity: false,
          wardrobe: false,
          productShape: false,
          logo: false,
          composition: false,
          background: false,
          scene: false,
          prompt: false,
          parameters: false,
        },
        versions: [],
        branches: [{
          id: 'main',
          label: '主版本',
          parentId: '',
          createdAt: '2026-01-01T00:00:00.000Z',
        }],
        brief: { goal: '雨夜短剧角色' },
      },
    },
  }]);
  const created = await fixture.request('/sessions', {
    method: 'POST',
    body: JSON.stringify({
      projectId: 'project-local',
      canvasId: 'canvas-a',
      context: { nodeCount: 1, edgeCount: 0, selectedNodeIds: ['candidate-a'] },
    }),
  });
  const sessionId = created.body.data.id;
  const comparison = await fixture.request(
    `/sessions/${sessionId}/comparison?projectId=project-local&canvasId=canvas-a&nodeId=candidate-a`,
  );
  assert.equal(comparison.response.status, 200);
  assert.equal(comparison.body.data.schema, 't8-creative-comparison-v2');
  assert.equal(comparison.body.data.candidates[0].nodeId, 'candidate-a');
  assert.equal(comparison.body.data.candidates[0].review.status, 'pending');

  const blockedAccept = await fixture.request(`/sessions/${sessionId}/iterate`, {
    method: 'POST',
    body: JSON.stringify({
      projectId: 'project-local',
      canvasId: 'canvas-a',
      action: 'accept',
      nodeId: 'candidate-a',
      context: { nodeCount: 1, edgeCount: 0, selectedNodeIds: ['candidate-a'] },
    }),
  });
  assert.equal(blockedAccept.response.status, 409);
  assert.equal(blockedAccept.body.code, 'CREATIVE_CANDIDATE_REVIEW_REQUIRED');

  const branched = await fixture.request(`/sessions/${sessionId}/iterate`, {
    method: 'POST',
    body: JSON.stringify({
      projectId: 'project-local',
      canvasId: 'canvas-a',
      action: 'branch',
      nodeId: 'candidate-a',
      label: '冷色探索',
      context: { nodeCount: 1, edgeCount: 0, selectedNodeIds: ['candidate-a'] },
    }),
  });
  assert.equal(branched.response.status, 201);
  assert.equal(branched.body.data.session.id, sessionId);
  assert.equal(branched.body.data.session.latestPlan.action, 'branch');
  assert.equal(branched.body.data.session.events.some((event) => event.type === 'user.action'), true);
  assert.equal(branched.body.data.session.events.at(-1).type, 'assistant.plan');

  const patch = await fixture.request(
    `/sessions/${sessionId}/plans/${branched.body.data.session.latestPlan.planId}/patch`
      + '?projectId=project-local&canvasId=canvas-a',
  );
  assert.equal(patch.response.status, 200);
  assert.equal(patch.body.data.patch.requiresConfirmation, true);
  assert.equal(patch.body.data.patch.operations[0].type, 'node.add');
  assert.equal(fixture.writes, 0);
  assert.equal(fixture.providerCalls, 0);
});

test('run-link reconciliation validates applied plan nodes and authoritative RunIntent evidence', async (t) => {
  const fixture = await startFixture(t);
  const created = await fixture.request('/sessions', {
    method: 'POST',
    body: JSON.stringify({
      projectId: 'project-local',
      canvasId: 'canvas-a',
      context: { nodeCount: 0, edgeCount: 0 },
    }),
  });
  const sessionId = created.body.data.id;
  const planned = await fixture.request(`/sessions/${sessionId}/messages`, {
    method: 'POST',
    body: JSON.stringify({
      projectId: 'project-local',
      canvasId: 'canvas-a',
      text: '生成雨夜唐人街电影感人物图',
      kind: 'image',
      context: { nodeCount: 0, edgeCount: 0 },
    }),
  });
  const plan = planned.body.data.session.latestPlan;
  fixture.registerCanvasPatch({
    patchId: plan.patchId,
    summary: 'creator agent plan',
    baseRevision: 12,
    appliedRevision: 13,
    revertedRevision: null,
    actorId: 'local-owner',
    status: 'applied',
    operationCount: 1,
    createdAt: 1,
    canRevert: true,
  });
  const applied = await fixture.request(`/sessions/${sessionId}/events`, {
    method: 'POST',
    body: JSON.stringify({
      projectId: 'project-local',
      canvasId: 'canvas-a',
      type: 'plan.applied',
      payload: {
        planId: plan.planId,
        planDigest: plan.planDigest,
        patchId: plan.patchId,
        appliedRevision: 13,
      },
    }),
  });
  assert.equal(applied.response.status, 201);
  assert.equal(applied.body.data.events.at(-1).payload.canvasEvidence.source, 'canvas-patch-ledger');
  assert.equal(applied.body.data.events.at(-1).payload.appliedRevision, 13);
  assert.equal(applied.body.data.events.at(-1).payload.productionEvidence.action, 'create.image');
  assert.equal(applied.body.data.production.currentPhase, 'candidates');
  assert.deepEqual(applied.body.data.production.completedPhases, ['idea']);
  const matchedNodeId = plan.targets.primaryNodeId;
  const artifactPath = path.join(fixture.rootDir, 'run-creator-a.png');
  fs.writeFileSync(artifactPath, VALID_PNG);
  const artifactHash = crypto.createHash('sha256').update(VALID_PNG).digest('hex');
  fixture.registerRunEvidence({
    run: {
      id: 'run-creator-a',
      projectId: 'project-local',
      canvasId: 'canvas-a',
      canvasRevision: 13,
      status: 'succeeded',
      createdAt: 1,
      finishedAt: 2,
      summary: { runIntentId: 'intent-creator-a' },
    },
    nodeRuns: [{
      id: 'node-run-creator-a',
      runId: 'run-creator-a',
      nodeId: matchedNodeId,
      originalNodeId: matchedNodeId,
      status: 'succeeded',
      inputSnapshot: {},
      outputRefs: ['asset-creator-a'],
    }],
    intent: {
      id: 'intent-creator-a',
      projectId: 'project-local',
      canvasId: 'canvas-a',
      runId: 'run-creator-a',
    },
    registeredAssets: [{
      id: 'asset-creator-a',
      projectId: 'project-local',
      kind: 'image',
      mimeType: 'image/png',
      contentHash: artifactHash,
      availability: 'available',
      storageMode: 'managed',
      managedPath: artifactPath,
      metadata: {
        width: 1,
        height: 1,
        canvasRevision: 13,
      },
      provenance: {
        source: 'run-output',
        runId: 'run-creator-a',
        nodeRunId: 'node-run-creator-a',
        attemptId: 'attempt-creator-a',
        canvasId: 'canvas-a',
        sourceNodeId: matchedNodeId,
        canvasRevision: 13,
      },
    }],
    attempts: {
      'node-run-creator-a': [{
        id: 'attempt-creator-a',
        nodeRunId: 'node-run-creator-a',
        status: 'succeeded',
      }],
    },
  });

  const first = await fixture.request(`/sessions/${sessionId}/run-links/reconcile`, {
    method: 'POST',
    body: JSON.stringify({
      projectId: 'project-local',
      canvasId: 'canvas-a',
      runIds: ['run-creator-a'],
    }),
  });
  const second = await fixture.request(`/sessions/${sessionId}/run-links/reconcile`, {
    method: 'POST',
    body: JSON.stringify({
      projectId: 'project-local',
      canvasId: 'canvas-a',
      runIds: ['run-creator-a'],
    }),
  });
  assert.equal(first.response.status, 200);
  assert.equal(first.body.data.session.runLinks.length, 1);
  assert.deepEqual(first.body.data.session.runLinks[0].matchedNodeIds, [matchedNodeId]);
  assert.equal(first.body.data.session.runLinks[0].runIntentId, 'intent-creator-a');
  assert.equal(second.body.data.session.runLinks.length, 1);
  assert.equal(second.body.data.session.events.filter((event) => event.type === 'run.linked').length, 1);

  const verified = await fixture.request(`/sessions/${sessionId}/runs/run-creator-a/verify-artifacts`, {
    method: 'POST',
    body: JSON.stringify({
      projectId: 'project-local',
      canvasId: 'canvas-a',
    }),
  });
  assert.equal(verified.response.status, 200);
  assert.equal(verified.body.data.verification.verified, true);
  assert.equal(verified.body.data.verification.assets.length, 1);
  assert.equal(verified.body.data.verification.assets[0].blobPresent, true);
  assert.equal(verified.body.data.verification.assets[0].hashVerified, true);
  assert.equal(verified.body.data.verification.assets[0].magicVerified, true);
  assert.equal(verified.body.data.verification.assets[0].associationVerified, true);
  assert.equal(verified.body.data.verification.assets[0].decodeEvidence, 'indexed-parser-verified');
  assert.equal(verified.body.data.session.production.completedPhases.includes('candidates'), true);

  const repeated = await fixture.request(`/sessions/${sessionId}/runs/run-creator-a/verify-artifacts`, {
    method: 'POST',
    body: JSON.stringify({
      projectId: 'project-local',
      canvasId: 'canvas-a',
    }),
  });
  assert.equal(repeated.response.status, 200);
  assert.equal(repeated.body.data.session.artifactVerifications.length, 1);
  assert.equal(
    repeated.body.data.session.events.filter((event) => event.type === 'run.artifacts-verified').length,
    1,
  );
});

test('applied Story plan derives script and asset-stage progress from the persisted canvas document', async (t) => {
  const fixture = await startFixture(t);
  const created = await fixture.request('/sessions', {
    method: 'POST',
    body: JSON.stringify({
      projectId: 'project-local',
      canvasId: 'canvas-a',
      context: { nodeCount: 0, edgeCount: 0 },
    }),
  });
  const sessionId = created.body.data.id;
  const planned = await fixture.request(`/sessions/${sessionId}/messages`, {
    method: 'POST',
    body: JSON.stringify({
      projectId: 'project-local',
      canvasId: 'canvas-a',
      text: '把雨夜重逢做成 30 秒短片，先给我可编辑分镜和资产计划',
      kind: 'story',
      context: { nodeCount: 0, edgeCount: 0 },
    }),
  });
  assert.equal(planned.response.status, 201);
  assert.equal(planned.body.data.session.production.currentPhase, 'idea');
  assert.deepEqual(planned.body.data.session.production.completedPhases, []);
  const plan = planned.body.data.session.latestPlan;
  const patchResult = await fixture.request(
    `/sessions/${sessionId}/plans/${plan.planId}/patch?projectId=project-local&canvasId=canvas-a`,
  );
  assert.equal(patchResult.response.status, 200);
  const patch = patchResult.body.data.patch;
  const storyNode = patch.operations
    .find((operation) => operation?.type === 'node.add'
      && operation.payload?.node?.type === 'story')?.payload?.node;
  assert.ok(storyNode);
  fixture.setCanvasDocument({ revision: 13, nodes: [storyNode] });
  fixture.registerCanvasPatch({
    patchId: plan.patchId,
    summary: 'create Story',
    baseRevision: 12,
    appliedRevision: 13,
    revertedRevision: null,
    actorId: 'local-owner',
    status: 'applied',
    operationCount: 1,
    createdAt: 1,
    canRevert: true,
  });
  const applied = await fixture.request(`/sessions/${sessionId}/events`, {
    method: 'POST',
    body: JSON.stringify({
      projectId: 'project-local',
      canvasId: 'canvas-a',
      type: 'plan.applied',
      payload: {
        planId: plan.planId,
        planDigest: plan.planDigest,
        patchId: plan.patchId,
        appliedRevision: 13,
      },
    }),
  });
  assert.equal(applied.response.status, 201);
  const evidence = applied.body.data.events.at(-1).payload.productionEvidence;
  assert.equal(evidence.source, 'canonical-canvas-evidence');
  assert.equal(evidence.documentVerified, true);
  assert.equal(evidence.story.verified, true);
  assert.equal(evidence.story.scriptReady, true);
  assert.equal(applied.body.data.production.currentPhase, 'assets');
  assert.deepEqual(applied.body.data.production.completedPhases, ['idea', 'script']);
  const serializedEvidence = JSON.stringify(evidence);
  assert.equal(serializedEvidence.includes('雨夜重逢'), false);
  assert.equal(serializedEvidence.includes('positivePrompt'), false);
});

test('canvas lifecycle accepts only authoritative Patch evidence and exact revert is idempotent', async (t) => {
  const fixture = await startFixture(t);
  const created = await fixture.request('/sessions', {
    method: 'POST',
    body: JSON.stringify({
      projectId: 'project-local',
      canvasId: 'canvas-a',
      context: { nodeCount: 0, edgeCount: 0 },
    }),
  });
  const sessionId = created.body.data.id;
  const planned = await fixture.request(`/sessions/${sessionId}/messages`, {
    method: 'POST',
    body: JSON.stringify({
      projectId: 'project-local',
      canvasId: 'canvas-a',
      text: '生成一张雨夜电影感人物图',
      kind: 'image',
      context: { nodeCount: 0, edgeCount: 0 },
    }),
  });
  const plan = planned.body.data.session.latestPlan;
  const appliedBody = {
    projectId: 'project-local',
    canvasId: 'canvas-a',
    type: 'plan.applied',
    payload: {
      planId: plan.planId,
      planDigest: plan.planDigest,
      patchId: plan.patchId,
      appliedRevision: 13,
    },
  };

  const missingLedger = await fixture.request(`/sessions/${sessionId}/events`, {
    method: 'POST',
    body: JSON.stringify(appliedBody),
  });
  assert.equal(missingLedger.response.status, 409);
  assert.equal(missingLedger.body.code, 'CREATOR_PATCH_EVIDENCE_NOT_FOUND');

  const expectedRequestDigest = canvasPatchRequestDigest(
    fixture.sessions.read(sessionId).latestPatch,
  );
  fixture.registerCanvasPatch({
    patchId: plan.patchId,
    requestDigest: '0'.repeat(64),
    summary: 'creator lifecycle test',
    baseRevision: 12,
    appliedRevision: 13,
    revertedRevision: null,
    actorId: 'codex-agent',
    status: 'applied',
    operationCount: 1,
    createdAt: 1,
    canRevert: true,
  });
  const mismatchedCrossActor = await fixture.request(`/sessions/${sessionId}/events`, {
    method: 'POST',
    body: JSON.stringify(appliedBody),
  });
  assert.equal(mismatchedCrossActor.response.status, 409);
  assert.equal(mismatchedCrossActor.body.code, 'CREATOR_PATCH_EVIDENCE_NOT_FOUND');

  fixture.registerCanvasPatch({
    patchId: plan.patchId,
    requestDigest: expectedRequestDigest,
    summary: 'creator lifecycle test',
    baseRevision: 12,
    appliedRevision: 13,
    revertedRevision: null,
    actorId: 'codex-agent',
    status: 'applied',
    operationCount: 1,
    createdAt: 1,
    canRevert: true,
  });
  const wrongRevision = await fixture.request(`/sessions/${sessionId}/events`, {
    method: 'POST',
    body: JSON.stringify({
      ...appliedBody,
      payload: { ...appliedBody.payload, appliedRevision: 99 },
    }),
  });
  assert.equal(wrongRevision.response.status, 409);
  assert.equal(wrongRevision.body.code, 'CREATOR_PATCH_REVISION_MISMATCH');

  const applied = await fixture.request(`/sessions/${sessionId}/events`, {
    method: 'POST',
    body: JSON.stringify(appliedBody),
  });
  const appliedAgain = await fixture.request(`/sessions/${sessionId}/events`, {
    method: 'POST',
    body: JSON.stringify({ ...appliedBody, payload: { ...appliedBody.payload, duplicate: true } }),
  });
  assert.equal(applied.response.status, 201);
  assert.equal(applied.body.data.events.at(-1).payload.canvasEvidence.actorId, 'codex-agent');
  assert.equal(appliedAgain.response.status, 201);
  assert.equal(appliedAgain.body.data.events.filter((event) => event.type === 'plan.applied').length, 1);

  fixture.registerCanvasPatch({
    patchId: plan.patchId,
    requestDigest: expectedRequestDigest,
    summary: 'creator lifecycle test',
    baseRevision: 12,
    appliedRevision: 13,
    revertedRevision: 14,
    actorId: 'codex-agent',
    status: 'reverted',
    operationCount: 1,
    createdAt: 1,
    canRevert: false,
  });
  const revertedBody = {
    projectId: 'project-local',
    canvasId: 'canvas-a',
    type: 'plan.reverted',
    payload: {
      planId: plan.planId,
      planDigest: plan.planDigest,
      patchId: plan.patchId,
      appliedRevision: 13,
      revertedRevision: 14,
    },
  };
  const reverted = await fixture.request(`/sessions/${sessionId}/events`, {
    method: 'POST',
    body: JSON.stringify(revertedBody),
  });
  const revertedAgain = await fixture.request(`/sessions/${sessionId}/events`, {
    method: 'POST',
    body: JSON.stringify({ ...revertedBody, payload: { ...revertedBody.payload, duplicate: true } }),
  });
  assert.equal(reverted.response.status, 201);
  assert.equal(revertedAgain.response.status, 201);
  assert.equal(revertedAgain.body.data.events.filter((event) => event.type === 'plan.reverted').length, 1);

  fixture.registerRunEvidence({
    run: {
      id: 'run-after-revert',
      projectId: 'project-local',
      canvasId: 'canvas-a',
      canvasRevision: 14,
      status: 'succeeded',
      summary: {},
    },
    nodeRuns: [{
      id: 'node-run-after-revert',
      runId: 'run-after-revert',
      nodeId: plan.targets.primaryNodeId,
      originalNodeId: plan.targets.primaryNodeId,
      status: 'succeeded',
      outputRefs: [],
    }],
  });
  const reconciled = await fixture.request(`/sessions/${sessionId}/run-links/reconcile`, {
    method: 'POST',
    body: JSON.stringify({
      projectId: 'project-local',
      canvasId: 'canvas-a',
      runIds: ['run-after-revert'],
    }),
  });
  assert.equal(reconciled.response.status, 200);
  assert.equal(reconciled.body.data.linked.length, 0);
});

test('asset placement is preview-first and records sent evidence only after the authoritative Patch is applied', async (t) => {
  const contentHash = 'a'.repeat(64);
  const asset = {
    id: 'asset-place-a',
    filename: 'hero.png',
    kind: 'image',
    mimeType: 'image/png',
    contentHash,
    contentRevision: 3,
    availability: 'available',
  };
  const placement = {
    nodeId: 'asset-node-a',
    nodeType: 'upload',
    position: { x: 120, y: 240 },
  };
  const patch = {
    schema: 't8-canvas-patch-v1',
    id: 'asset-place-patch-a',
    baseRevision: 12,
    summary: '把 hero.png 放入画布',
    diagnosticsResolved: [],
    requiresConfirmation: true,
    operations: [{
      opId: 'asset-place-op-a',
      type: 'node.add',
      payload: {
        node: {
          id: placement.nodeId,
          type: placement.nodeType,
          position: placement.position,
          data: {
            assets: [{
              id: asset.id,
              kind: asset.kind,
              contentHash,
            }],
          },
        },
      },
    }],
  };
  let inspectCalls = 0;
  const fixture = await startFixture(t, [], {
    assetService: {
      async inspectPlace(assetId, document, options) {
        inspectCalls += 1;
        assert.equal(assetId, asset.id);
        assert.equal([12, 13].includes(document.revision), true);
        assert.equal(options.projectId, 'project-local');
        return { asset: structuredClone(asset), placement: structuredClone(placement),
          patch: { ...structuredClone(patch), baseRevision: document.revision } };
      },
    },
  });
  const created = await fixture.request('/sessions', {
    method: 'POST',
    body: JSON.stringify({
      projectId: 'project-local',
      canvasId: 'canvas-a',
      context: { nodeCount: 0, edgeCount: 0 },
    }),
  });
  const sessionId = created.body.data.id;
  const planned = await fixture.request(`/sessions/${sessionId}/assets/${asset.id}/place-plan`, {
    method: 'POST',
    body: JSON.stringify({
      projectId: 'project-local',
      canvasId: 'canvas-a',
      context: { nodeCount: 0, edgeCount: 0 },
    }),
  });
  assert.equal(planned.response.status, 201);
  assert.equal(inspectCalls, 1);
  assert.equal(fixture.writes, 0);
  assert.equal(fixture.providerCalls, 0);
  assert.equal(planned.body.data.plan.action, 'asset.place');
  assert.equal(planned.body.data.plan.ready, true);
  assert.equal(planned.body.data.plan.assetPlacement.asset.id, asset.id);
  assert.equal(planned.body.data.patch.id, patch.id);
  assert.equal(planned.body.data.patch.requiresConfirmation, true);

  const plan = planned.body.data.plan;
  const evidenceBody = {
    projectId: 'project-local',
    canvasId: 'canvas-a',
    type: 'artifact.sent-to-canvas',
    payload: {
      planId: plan.planId,
      planDigest: plan.planDigest,
      patchId: patch.id,
      assetId: asset.id,
      contentHash,
      nodeId: placement.nodeId,
      appliedRevision: 13,
    },
  };
  const beforeApply = await fixture.request(`/sessions/${sessionId}/events`, {
    method: 'POST',
    body: JSON.stringify(evidenceBody),
  });
  assert.equal(beforeApply.response.status, 409);
  assert.equal(beforeApply.body.code, 'CREATOR_ASSET_PLACE_EVIDENCE_INVALID');

  fixture.registerCanvasPatch({
    patchId: patch.id,
    requestDigest: canvasPatchRequestDigest(fixture.sessions.read(sessionId).latestPatch),
    previewDigest: 'b'.repeat(64),
    diagnosticsResolved: [],
    affectedNodeIds: [placement.nodeId],
    affectedEdgeIds: [],
    changes: [{ kind: 'node.add', nodeId: placement.nodeId }],
    summary: patch.summary,
    baseRevision: 12,
    appliedRevision: 13,
    revertedRevision: null,
    actorId: 'local-owner',
    status: 'applied',
    operationCount: 1,
    createdAt: 1,
    canRevert: true,
  });
  fixture.setCanvasDocument({
    revision: 13,
    nodes: [patch.operations[0].payload.node],
  });
  const recovered = await fixture.request(`/sessions/${sessionId}/assets/${asset.id}/place-plan`, {
    method: 'POST',
    body: JSON.stringify({
      projectId: 'project-local',
      canvasId: 'canvas-a',
      context: { nodeCount: 1, edgeCount: 0 },
    }),
  });
  assert.equal(recovered.response.status, 200);
  assert.equal(recovered.body.data.alreadyApplied.patchId, patch.id);
  assert.equal(recovered.body.data.alreadyApplied.baseRevision, 12);
  assert.equal(recovered.body.data.alreadyApplied.appliedRevision, 13);
  assert.equal(recovered.body.data.patch.baseRevision, 12);
  assert.equal(recovered.body.data.plan.assetPlacement.asset.id, asset.id);
  assert.equal(fixture.writes, 0);
  assert.equal(fixture.providerCalls, 0);
  const applied = await fixture.request(`/sessions/${sessionId}/events`, {
    method: 'POST',
    body: JSON.stringify({
      projectId: 'project-local',
      canvasId: 'canvas-a',
      type: 'plan.applied',
      payload: {
        planId: plan.planId,
        planDigest: plan.planDigest,
        patchId: patch.id,
        appliedRevision: 13,
      },
    }),
  });
  assert.equal(applied.response.status, 201);

  const sent = await fixture.request(`/sessions/${sessionId}/events`, {
    method: 'POST',
    body: JSON.stringify(evidenceBody),
  });
  assert.equal(sent.response.status, 201);
  const sentEvidence = sent.body.data.events.find((event) => event.type === 'artifact.sent-to-canvas');
  assert.equal(sentEvidence.payload.schema, 't8-creator-artifact-canvas-evidence-v1');
  assert.equal(sentEvidence.payload.assetId, asset.id);
  assert.equal(sentEvidence.payload.contentHash, contentHash);
  assert.equal(sentEvidence.payload.nodeId, placement.nodeId);
  assert.equal(sentEvidence.payload.appliedRevision, 13);
});

test('durable chat attachments bind their project asset to the CreativePlan', async (t) => {
  const fixture = await startFixture(t);
  const created = await fixture.request('/sessions', {
    method: 'POST',
    body: JSON.stringify({
      projectId: 'project-local',
      canvasId: 'canvas-a',
      context: { nodeCount: 0, edgeCount: 0 },
    }),
  });
  const sessionId = created.body.data.id;

  const planned = await fixture.request(`/sessions/${sessionId}/messages`, {
    method: 'POST',
    body: JSON.stringify({
      projectId: 'project-local',
      canvasId: 'canvas-a',
      text: '只把这张图的背景改成雨夜，人物不变',
      kind: 'edit-image',
      attachments: [{
        id: 'attachment-image-a',
        assetId: 'asset-image-a',
        kind: 'image',
        name: 'character.png',
        ref: '/api/project-assets/asset-image-a/media',
        mimeType: 'image/png',
        size: 1024,
      }],
      context: { nodeCount: 0, edgeCount: 0 },
    }),
  });

  assert.equal(planned.response.status, 201);
  assert.equal(planned.body.data.session.latestPlan.kind, 'edit-image');
  assert.equal(planned.body.data.session.latestPlan.ready, true);
  assert.deepEqual(planned.body.data.session.latestPlan.brief.reuseAssetIds, ['asset-image-a']);
  assert.equal(planned.body.data.userEvent.payload.attachments[0].assetId, 'asset-image-a');
  assert.equal(fixture.writes, 0);
  assert.equal(fixture.providerCalls, 0);
});

test('a durable attachment can start analysis without typed text or leaking attachment metadata', async (t) => {
  const fixture = await startFixture(t);
  const created = await fixture.request('/sessions', {
    method: 'POST',
    body: JSON.stringify({
      projectId: 'project-local',
      canvasId: 'canvas-a',
      context: { nodeCount: 0, edgeCount: 0 },
    }),
  });
  const sessionId = created.body.data.id;
  const planned = await fixture.request(`/sessions/${sessionId}/messages`, {
    method: 'POST',
    body: JSON.stringify({
      projectId: 'project-local',
      canvasId: 'canvas-a',
      text: '',
      kind: 'edit-image',
      attachments: [{
        id: 'private-route-attachment',
        assetId: 'asset-image-a',
        kind: 'image',
        name: 'private-route-character.png',
        ref: '/api/project-assets/asset-image-a/media',
        mimeType: 'image/png',
        size: 1024,
      }],
      context: { nodeCount: 0, edgeCount: 0 },
    }),
  });

  assert.equal(planned.response.status, 201);
  assert.equal(planned.body.data.session.latestPlan.kind, 'edit-image');
  assert.equal(planned.body.data.session.latestPlan.ready, true);
  assert.deepEqual(planned.body.data.session.latestPlan.brief.reuseAssetIds, ['asset-image-a']);
  assert.equal(planned.body.data.userEvent.payload.inputMode, 'attachments-only');
  assert.equal(planned.body.data.session.title, '分析1 张图片');
  const effectivePrompt = planned.body.data.userEvent.payload.text;
  assert.equal(
    effectivePrompt,
    '请分析我上传的1 张图片，先说明可直接使用的内容和缺失信息，再给出 3 个可执行的创作下一步；不要自动生成或修改画布。',
  );
  for (const privateValue of [
    'private-route-attachment',
    'asset-image-a',
    'private-route-character.png',
    '/api/project-assets/asset-image-a/media',
  ]) {
    assert.equal(effectivePrompt.includes(privateValue), false);
  }
  assert.equal(fixture.writes, 0);
  assert.equal(fixture.providerCalls, 0);
});

test('reference video breakdown keeps its verified video and recipe across suggestion follow-ups', async (t) => {
  const fixture = await startFixture(t);
  fixture.registerAsset({
    id: 'asset-reference-video',
    projectId: 'project-local',
    kind: 'video',
    availability: 'available',
    contentRevision: 4,
    contentHash: 'b'.repeat(64),
    filename: 'reference-cut.mp4',
    mimeType: 'video/mp4',
    byteSize: 4_096,
  });
  const created = await fixture.request('/sessions', {
    method: 'POST',
    body: JSON.stringify({
      projectId: 'project-local',
      canvasId: 'canvas-a',
      context: { nodeCount: 0, edgeCount: 0 },
    }),
  });
  const sessionId = created.body.data.id;
  const planned = await fixture.request(`/sessions/${sessionId}/messages`, {
    method: 'POST',
    body: JSON.stringify({
      projectId: 'project-local',
      canvasId: 'canvas-a',
      text: '帮我拉片，逐镜头分析时间码、景别、运镜、声音和剪辑节奏',
      kind: 'story',
      recipe: 'shot-breakdown',
      attachments: [{
        id: 'attachment-reference-video',
        assetId: 'asset-reference-video',
        kind: 'video',
        name: 'reference-cut.mp4',
        ref: '/api/project-assets/asset-reference-video/media',
        mimeType: 'video/mp4',
        size: 4_096,
      }],
      context: { nodeCount: 0, edgeCount: 0 },
    }),
  });

  assert.equal(planned.response.status, 201);
  const firstSession = planned.body.data.session;
  assert.equal(firstSession.latestPlan.kind, 'story');
  assert.equal(firstSession.latestPlan.brief.recipe, 'shot-breakdown');
  assert.deepEqual(firstSession.latestPlan.brief.reuseAssetIds, ['asset-reference-video']);
  assert.deepEqual(firstSession.latestPlan.productionDocuments.map((item) => item.kind), [
    'production-brief',
    'reference-breakdown',
  ]);
  assert.deepEqual(firstSession.latestPlan.targets.proposedNodes.map((node) => node.type), [
    'upload',
    'text',
    'llm',
    'output',
  ]);
  assert.deepEqual(
    firstSession.latestPlan.modelDecisionReceipt.decisions.map((decision) => decision.kind),
    ['llm', 'audio'],
  );
  assert.equal(firstSession.latestPlan.modelDecisionReceipt.decisions[1].status, 'blocked');
  assert.equal(firstSession.latestPlan.modelDecisionReceipt.decisions[1].required, false);
  const suggestion = firstSession.suggestionSet.items[0];
  assert.equal(suggestion.intent, 'reference-breakdown.rhythm');

  const continued = await fixture.request(`/sessions/${sessionId}/messages`, {
    method: 'POST',
    body: JSON.stringify({
      projectId: 'project-local',
      canvasId: 'canvas-a',
      suggestion: {
        id: suggestion.id,
        setDigest: firstSession.suggestionSet.setDigest,
      },
      context: { nodeCount: 0, edgeCount: 0 },
    }),
  });

  assert.equal(continued.response.status, 201);
  const continuedPlan = continued.body.data.session.latestPlan;
  assert.equal(continuedPlan.kind, 'story');
  assert.equal(continuedPlan.brief.recipe, 'shot-breakdown');
  assert.deepEqual(continuedPlan.brief.reuseAssetIds, ['asset-reference-video']);
  assert.equal(continuedPlan.questions.length, 0);
  assert.equal(
    continuedPlan.productionDocuments.find((item) => item.kind === 'reference-breakdown')
      .content.sourceBinding.assetId,
    'asset-reference-video',
  );
  assert.deepEqual(
    continuedPlan.modelDecisionReceipt.decisions.map((decision) => decision.kind),
    ['llm', 'audio'],
  );
  assert.equal(continuedPlan.modelDecisionReceipt.decisions[1].status, 'blocked');
  assert.equal(continuedPlan.modelDecisionReceipt.decisions[1].required, false);
  assert.equal(fixture.writes, 0);
  assert.equal(fixture.providerCalls, 0);

  const sourceBinding = {
    assetId: 'asset-reference-video',
    kind: 'video',
    contentRevision: 4,
    contentHash: 'b'.repeat(64),
    filename: 'reference-cut.mp4',
    mimeType: 'video/mp4',
    byteSize: 4_096,
  };
  const resultNode = {
    id: 'llm-reference-breakdown-result',
    type: 'llm',
    position: { x: 500, y: 120 },
    data: {
      analysisMode: 'reference-video-shot-breakdown',
      outputSchema: 't8-reference-video-breakdown-v2',
      requestId: 'request-reference-breakdown',
      status: 'success',
      referenceAssetIds: ['asset-reference-video'],
      referenceBindings: [sourceBinding],
      reply: JSON.stringify({
        sourceAsset: {
          assetId: 'asset-reference-video',
          contentRevision: 4,
          contentHash: 'b'.repeat(64),
        },
        summary: {
          totalDuration: '6 秒',
          shotCount: 2,
          averageShotDuration: '3 秒',
          editingDensity: '两镜均匀切换',
          rhythmPattern: '先静后动',
          cameraLanguage: '建立镜头后切入中景跟拍',
          soundStructure: '当前证据不足',
        },
        shots: [{
          ordinal: 1,
          startTimecode: '00:00:00.000',
          endTimecode: '00:00:03.000',
          durationSec: 3,
          shotSize: '大全景',
          cameraMovement: '缓慢推进',
          composition: '巷道纵深构图',
          action: '空镜建立雨夜环境',
          dialogue: '未知',
          narration: '未知',
          music: '未知',
          ambience: '未知',
          sfx: '未知',
          editablePrompt: '原创雨夜巷道建立镜头，强调纵深和反射，不使用参考片具体角色或品牌',
          confidence: 0.9,
          evidence: ['00:00:00.000 采样帧'],
          unknowns: ['声音未分析'],
        }, {
          ordinal: 2,
          startTimecode: '00:00:03.000',
          endTimecode: '00:00:06.000',
          durationSec: 3,
          shotSize: '中景',
          cameraMovement: '稳定跟拍',
          composition: '主体居中',
          action: '原创人物从画外进入并向前移动',
          dialogue: '未知',
          narration: '未知',
          music: '未知',
          ambience: '未知',
          sfx: '未知',
          editablePrompt: '原创人物进入画面，中景稳定跟拍，保持身份与服装连续',
          confidence: 0.85,
          evidence: ['00:00:03.000 采样帧'],
          unknowns: ['精确切点未知'],
        }],
        limitations: ['只使用受控采样帧，精确切点需人工核对'],
      }),
    },
  };
  fixture.setCanvasDocument({ nodes: [resultNode], revision: 12 });
  fixture.registerRunEvidence({
    run: {
      id: 'run-reference-breakdown',
      projectId: 'project-local',
      canvasId: 'canvas-a',
      canvasRevision: 12,
      status: 'running',
      createdAt: 20,
    },
    nodeRuns: [{
      id: 'node-run-reference-breakdown',
      runId: 'run-reference-breakdown',
      originalNodeId: resultNode.id,
      status: 'succeeded',
      inputSnapshot: {
        replayable: true,
        node: structuredClone(resultNode),
      },
    }],
    attempts: {
      'node-run-reference-breakdown': [{
        id: 'attempt-reference-breakdown',
        nodeRunId: 'node-run-reference-breakdown',
        requestId: 'request-reference-breakdown',
        status: 'succeeded',
      }],
    },
  });

  const reviewed = await fixture.request(`/sessions/${sessionId}/messages`, {
    method: 'POST',
    body: JSON.stringify({
      projectId: 'project-local',
      canvasId: 'canvas-a',
      text: '核对当前参考视频拉片结果',
      kind: 'story',
      recipe: 'shot-breakdown',
      assetIds: ['asset-reference-video'],
      context: { nodeCount: 1, edgeCount: 0 },
    }),
  });
  assert.equal(reviewed.response.status, 201, JSON.stringify(reviewed.body));
  const reviewedSession = reviewed.body.data.session;
  assert.equal(reviewedSession.latestPlan.action, 'review.reference-breakdown');
  const reviewedDocument = reviewedSession.latestPlan.productionDocuments
    .find((item) => item.kind === 'reference-breakdown');
  assert.equal(reviewedDocument.content.status, 'analysis-result-ready');
  assert.equal(reviewedDocument.content.resultEvidence.runBindingStatus, 'verified');
  const continueSuggestion = reviewedSession.suggestionSet.items
    .find((item) => item.intent === 'reference-breakdown.continue-production');
  assert.equal(continueSuggestion.executable, true);

  const production = await fixture.request(`/sessions/${sessionId}/messages`, {
    method: 'POST',
    body: JSON.stringify({
      projectId: 'project-local',
      canvasId: 'canvas-a',
      suggestion: {
        id: continueSuggestion.id,
        setDigest: reviewedSession.suggestionSet.setDigest,
      },
      context: { nodeCount: 1, edgeCount: 0 },
    }),
  });
  assert.equal(production.response.status, 201);
  const productionPlan = production.body.data.session.latestPlan;
  assert.equal(productionPlan.kind, 'story');
  assert.equal(productionPlan.action, 'create.story');
  assert.equal(productionPlan.brief.recipe, 'storyboard');
  assert.match(productionPlan.brief.goal, /参考视频镜头语法的原创改编/);
  assert.match(productionPlan.brief.goal, /【镜头1[|｜]00:00:00\.000 - 00:00:03\.000】/);
  assert.doesNotMatch(productionPlan.brief.goal, /逐镜头分析时间码、景别、运镜、声音和剪辑节奏/);
  assert.deepEqual(productionPlan.targets.proposedNodes.map((node) => node.type), ['story']);
  assert.equal(
    productionPlan.productionDocuments.some((item) => item.kind === 'reference-breakdown'),
    false,
  );
  const shotList = productionPlan.productionDocuments.find((item) => item.kind === 'shot-list');
  assert.equal(shotList.content.shots.length, 2);
  assert.match(shotList.content.shots[0].sourceText, /空镜建立雨夜环境/);
  assert.deepEqual(productionPlan.brief.reuseAssetIds, ['asset-reference-video']);
  assert.equal(production.body.data.userEvent.payload.text, continueSuggestion.label);
  assert.equal(fixture.writes, 0);
  assert.equal(fixture.providerCalls, 0);
});

test('session scope mismatch fails closed and does not leak plans across canvases', async (t) => {
  const fixture = await startFixture(t);
  const created = await fixture.request('/sessions', {
    method: 'POST',
    body: JSON.stringify({
      projectId: 'project-local',
      canvasId: 'canvas-a',
      context: {},
    }),
  });
  const sessionId = created.body.data.id;
  const mismatch = await fixture.request(
    `/sessions/${sessionId}?projectId=project-local&canvasId=canvas-other`,
  );
  assert.equal(mismatch.response.status, 409);
  assert.equal(mismatch.body.code, 'CREATOR_SESSION_SCOPE_MISMATCH');
  assert.equal(fixture.writes, 0);
});

test('delivery stays in one Creator Session, requires approval and verifies a pinned package digest', async (t) => {
  const packageDigest = 'b'.repeat(64);
  let approvalStatus = 'pending';
  let approvalRecord = null;
  let inspectCalls = 0;
  let packageCalls = 0;
  let verifyCalls = 0;
  let finishCalls = 0;
  const approvals = {
    create(input) {
      approvalRecord = {
        ...structuredClone(input),
        approvalRequestId: 'approval-delivery-a',
      };
      return {
        approvalRequestId: 'approval-delivery-a',
        pollSecret: 'server-only-secret',
        expiresAt: '2027-01-01T00:00:00.000Z',
        preview: structuredClone(input.preview),
      };
    },
    beginCompletion({ approvalRequestId, pollSecret }) {
      assert.equal(approvalRequestId, 'approval-delivery-a');
      assert.equal(pollSecret, 'server-only-secret');
      if (approvalStatus === 'pending') return { status: 'pending' };
      if (approvalStatus === 'denied') return { status: 'denied' };
      return { status: 'approved', record: approvalRecord };
    },
    finishCompletion(record, success) {
      assert.equal(record, approvalRecord);
      assert.equal(success, true);
      finishCalls += 1;
    },
  };
  const deliveryService = {
    async inspectPackage(document, options) {
      inspectCalls += 1;
      assert.equal(document.canvasId, 'canvas-a');
      assert.equal(options.scope, 'canvas');
      const basename = path.basename(options.targetPath);
      return {
        target: {
          absolute: options.targetPath,
          basename,
        },
        collection: {
          scope: 'canvas',
          canvasRevision: 12,
          items: [{
            assetId: 'asset-delivery-a',
            kind: 'image',
            filename: 'final.png',
            size: 68,
            sha256: 'a'.repeat(64),
            renditionRole: 'primary',
            licenseStatus: 'unknown',
          }],
          totalBytes: 68,
          selectionDigest: 'c'.repeat(64),
          licenseSummary: { known: 0, unknown: 1 },
        },
        preview: {
          summary: '将 1 个已核验素材写入本机交付包',
          riskLevel: 'L2',
          operationCount: 1,
          destination: `本机目录 / ${basename}`,
          package: {
            name: basename,
            itemCount: 1,
            totalBytes: 68,
            selectionDigest: 'c'.repeat(64),
            assets: [{
              assetId: 'asset-delivery-a',
              kind: 'image',
              filename: 'final.png',
              size: 68,
              sha256: 'a'.repeat(64),
              renditionRole: 'primary',
              licenseStatus: 'unknown',
            }],
          },
          warnings: ['1 个素材缺少明确许可记录'],
        },
      };
    },
    async packageDelivery(document, snapshot) {
      packageCalls += 1;
      assert.equal(document.canvasId, 'canvas-a');
      assert.equal(snapshot.collection.selectionDigest, 'c'.repeat(64));
      return {
        files: [{
          assetId: 'asset-delivery-a',
          size: 68,
          sha256: 'a'.repeat(64),
        }],
        packageName: snapshot.target.basename,
        itemCount: 1,
        totalBytes: 68,
        packageDigest,
        licenseSummary: { known: 0, unknown: 1 },
      };
    },
    async verifyPackage(targetPath, options) {
      verifyCalls += 1;
      assert.equal(path.isAbsolute(targetPath), true);
      assert.equal(options.expectedPackageDigest, packageDigest);
      return {
        valid: true,
        verifiedItems: 1,
        verifiedBytes: 68,
        failures: [],
      };
    },
  };
  const fixture = await startFixture(t, [], { approvals, deliveryService });
  const created = await fixture.request('/sessions', {
    method: 'POST',
    body: JSON.stringify({
      projectId: 'project-local',
      canvasId: 'canvas-a',
      context: { outputAssetCount: 1 },
    }),
  });
  const sessionId = created.body.data.id;
  const intent = await fixture.request(`/sessions/${sessionId}/messages`, {
    method: 'POST',
    body: JSON.stringify({
      projectId: 'project-local',
      canvasId: 'canvas-a',
      text: '把当前画布已验证素材打包交付',
      context: { outputAssetCount: 1 },
    }),
  });
  assert.equal(intent.response.status, 201);
  assert.equal(intent.body.data.session.latestPlan.kind, 'delivery');
  assert.equal(intent.body.data.session.latestPlan.ready, false);
  assert.equal(inspectCalls, 0);

  const privateParent = path.join(fixture.rootDir, 'creator-private-parent');
  const planned = await fixture.request(`/sessions/${sessionId}/delivery/plan`, {
    method: 'POST',
    body: JSON.stringify({
      projectId: 'project-local',
      canvasId: 'canvas-a',
      parentPath: privateParent,
      packageName: 'final-delivery',
      scope: 'canvas',
      context: { outputAssetCount: 1 },
    }),
  });
  assert.equal(planned.response.status, 201);
  assert.equal(planned.body.data.session.latestPlan.ready, true);
  assert.equal(planned.body.data.session.latestPlan.delivery.itemCount, 1);
  assert.equal(JSON.stringify(planned.body).includes(privateParent), false);
  assert.equal(inspectCalls, 1);

  const planId = planned.body.data.session.latestPlan.planId;
  const requested = await fixture.request(`/sessions/${sessionId}/delivery/${planId}/request-approval`, {
    method: 'POST',
    body: JSON.stringify({ projectId: 'project-local', canvasId: 'canvas-a' }),
  });
  assert.equal(requested.response.status, 202);
  assert.equal(requested.body.data.status, 'pending');
  assert.equal(requested.body.data.preview.operationCount, 1);
  assert.equal(JSON.stringify(requested.body).includes('server-only-secret'), false);
  assert.equal(JSON.stringify(requested.body).includes(privateParent), false);
  assert.equal(packageCalls, 0);

  const completeUrl = `/sessions/${sessionId}/delivery/approvals/approval-delivery-a/complete`;
  const stillPending = await fixture.request(completeUrl, {
    method: 'POST',
    body: JSON.stringify({ projectId: 'project-local', canvasId: 'canvas-a' }),
  });
  assert.equal(stillPending.body.data.status, 'pending');
  assert.equal(packageCalls, 0);

  approvalStatus = 'approved';
  const completed = await fixture.request(completeUrl, {
    method: 'POST',
    body: JSON.stringify({ projectId: 'project-local', canvasId: 'canvas-a' }),
  });
  assert.equal(completed.response.status, 200);
  assert.equal(completed.body.data.status, 'completed');
  assert.equal(completed.body.data.evidence.packageDigest, packageDigest);
  assert.equal(completed.body.data.evidence.valid, true);
  assert.equal(JSON.stringify(completed.body).includes(privateParent), false);
  assert.equal(packageCalls, 1);
  assert.equal(verifyCalls, 1);
  assert.equal(completed.body.data.evidence.scope, 'canvas');
  assert.equal(completed.body.data.evidence.canvasRevision, 12);
  assert.equal(completed.body.data.evidence.selectionDigest, 'c'.repeat(64));
  assert.deepEqual(completed.body.data.evidence.files, [{
    assetId: 'asset-delivery-a',
    size: 68,
    sha256: 'a'.repeat(64),
  }]);
  assert.equal(finishCalls, 1);

  const repeated = await fixture.request(completeUrl, {
    method: 'POST',
    body: JSON.stringify({ projectId: 'project-local', canvasId: 'canvas-a' }),
  });
  assert.equal(repeated.body.data.status, 'completed');
  assert.equal(packageCalls, 1);
  assert.equal(verifyCalls, 1);
  assert.equal(finishCalls, 1);
  assert.equal(repeated.body.data.session.deliveryEvidence.length, 1);
  assert.equal(fixture.writes, 0);
  assert.equal(fixture.providerCalls, 0);
});
