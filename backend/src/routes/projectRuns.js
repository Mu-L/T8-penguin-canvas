const express = require('express');
const config = require('../config');
const { getProjectDatabase } = require('../services/projectDatabase');
const { getBackgroundAssetIndexer } = require('../services/assetIndexer');
const { getAssetPreviewPipeline } = require('../services/assetPreviewPipeline');
const { publicAsset } = require('../services/assetPublicView');
const { redactAndScanRunValue } = require('../services/runRedaction');
const { normalizeRunError } = require('../services/runErrors');
const { explicitRunCost } = require('../services/runUsage');
const { getRunRecoveryManager } = require('../services/runRecovery');
const { getCollaborationGateway } = require('../collaboration/gateway');
const { ExecutionPolicyError, HostExecutionPolicy } = require('../collaboration/executionPolicy');
const {
  normalizeRunStatus,
  normalizeNodeRunStatus,
  runEventTypeForStatus,
  nodeRunEventTypeForStatus,
  normalizeRunEventType,
} = require('../services/runLifecycle');

const router = express.Router();
const TERMINAL_NODE_RUN_STATUSES = new Set(['succeeded', 'failed', 'stopped', 'interrupted']);
const database = getProjectDatabase(config);
const previewPipeline = getAssetPreviewPipeline(config, database);
const assetIndexer = getBackgroundAssetIndexer(config, database, previewPipeline);
const collaborationGateway = getCollaborationGateway(config);
const runExecutionPolicy = new HostExecutionPolicy(database);
const recoveryManager = getRunRecoveryManager({
  database,
  baseUrl: `http://127.0.0.1:${config.PORT}`,
  broadcast: {
    intent: (intent) => collaborationGateway.broadcastHostRunIntent(intent),
    run: (run) => collaborationGateway.broadcastHostRunState(run),
    node: (run, nodeRun) => collaborationGateway.broadcastHostNodeRunState(run, nodeRun),
    output: (run, nodeRun, assets) => collaborationGateway.broadcastHostRunOutput(run, nodeRun, assets),
  },
  recordRunOutputAssets: (input) => assetIndexer.recordRunOutputAssets(input),
});

function requireRun(runId, res) {
  const run = database.getRun(runId);
  if (!run) res.status(404).json({ success: false, error: '运行记录不存在' });
  return run;
}

router.get('/', (req, res) => {
  res.json({
    success: true,
    data: database.listRuns({
      projectId: req.query.projectId,
      canvasId: req.query.canvasId,
      status: req.query.status,
      initiatorId: req.query.initiatorId,
      provider: req.query.provider,
      model: req.query.model,
      limit: req.query.limit,
    }),
  });
});

router.post('/', (req, res) => {
  try {
    const summary = redactAndScanRunValue(req.body?.summary || {});
    const runIntentId = typeof summary.runIntentId === 'string' && summary.runIntentId ? summary.runIntentId : null;
    const legacyAcceptedRecovery = summary.runIntentRecovery === 'legacy-accepted';
    let claimedIntent = null;
    const create = database.db.transaction(() => {
      let intent = runIntentId ? database.getRunIntent(runIntentId) : null;
      if (runIntentId) {
        const authorized = runExecutionPolicy.authorizeRunIntent(runIntentId, {
          allowedStatuses: legacyAcceptedRecovery ? ['accepted'] : ['pending'],
          requireUnclaimed: true,
          reservationAlreadyCounted: true,
        });
        intent = authorized.intent;
      }
      const created = database.createRun({
        ...req.body,
        ...(intent ? {
          projectId: intent.projectId,
          canvasId: intent.canvasId,
          canvasRevision: intent.canvasRevision,
          initiatorId: intent.requestedBy,
        } : {}),
        status: 'queued',
        summary,
      });
      if (intent) claimedIntent = database.claimRunIntent(intent.id, created);
      database.appendRunEvent(created.id, { type: 'run.queued', payload: { status: 'queued' } });
      return created;
    });
    const run = create.immediate();
    collaborationGateway.broadcastHostRunState(run);
    if (claimedIntent) collaborationGateway.broadcastHostRunIntent(claimedIntent);
    res.status(201).json({ success: true, data: run });
  } catch (error) {
    if (error instanceof ExecutionPolicyError) {
      return res.status(error.httpStatus || 429).json({ success: false, code: error.code, error: error.message, data: error.details });
    }
    res.status(400).json({ success: false, error: error?.message || String(error) });
  }
});

router.get('/retention', (req, res) => {
  res.json({
    success: true,
    data: database.getRunRetentionPolicy(req.query.projectId),
  });
});

router.put('/retention', (req, res) => {
  try {
    const policy = database.setRunRetentionPolicy(req.body?.projectId, req.body || {});
    res.json({ success: true, data: policy });
  } catch (error) {
    res.status(400).json({ success: false, error: error?.message || String(error) });
  }
});

router.post('/retention/prune', (req, res) => {
  try {
    const result = database.pruneRuns(req.body?.projectId);
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(400).json({ success: false, error: error?.message || String(error) });
  }
});

router.get('/recovery', (_req, res) => {
  res.json({
    success: true,
    data: {
      startup: database.lastInterruptedRecovery,
      manager: recoveryManager.status(),
      pending: database.listPendingRunRecoveries().length,
    },
  });
});

router.post('/recover-interrupted', async (_req, res) => {
  try {
    const prepared = database.recoverInterruptedRuns();
    const recovered = await recoveryManager.recoverPendingRuns();
    res.json({ success: true, data: { prepared, recovered } });
  } catch (error) {
    res.status(500).json({ success: false, error: error?.message || String(error) });
  }
});

router.get('/:runId', (req, res) => {
  const run = requireRun(req.params.runId, res);
  if (!run) return;
  const nodeRuns = database.listNodeRuns(run.id).map((nodeRun) => ({
    ...nodeRun,
    attempts: database.listAttempts(nodeRun.id),
  }));
  res.json({ success: true, data: { ...run, nodeRuns } });
});

router.patch('/:runId', (req, res) => {
  if (!requireRun(req.params.runId, res)) return;
  try {
    const requestedStatus = req.body?.status === undefined ? undefined : normalizeRunStatus(req.body.status);
    const summary = redactAndScanRunValue(req.body?.summary || {});
    const commitRunUpdate = database.db.transaction(() => {
      const current = database.getRun(req.params.runId);
      if (!current) throw new Error('运行记录不存在');
      const run = database.updateRun(current.id, {
        status: requestedStatus,
        startedAt: req.body?.startedAt,
        finishedAt: req.body?.finishedAt,
        summary,
      });
      if (requestedStatus) {
        database.appendRunEvent(run.id, {
          type: runEventTypeForStatus(requestedStatus),
          payload: { status: requestedStatus },
        });
      }
      const completedIntent = requestedStatus && ['succeeded', 'failed', 'stopped', 'interrupted'].includes(requestedStatus)
        ? database.finishRunIntentForRun(
            run.id,
            requestedStatus,
            explicitRunCost(database.listRunAttempts(run.id)),
          )
        : null;
      return { run, completedIntent };
    });
    const result = commitRunUpdate.immediate();
    collaborationGateway.broadcastHostRunState(result.run);
    if (result.completedIntent) collaborationGateway.broadcastHostRunIntent(result.completedIntent);
    res.json({ success: true, data: result.run });
  } catch (error) {
    res.status(400).json({ success: false, error: error?.message || String(error) });
  }
});

router.get('/:runId/events', (req, res) => {
  if (!requireRun(req.params.runId, res)) return;
  res.json({ success: true, data: database.getRunEvents(req.params.runId, req.query.afterId) });
});

router.post('/:runId/events', (req, res) => {
  if (!requireRun(req.params.runId, res)) return;
  try {
    if (req.body?.nodeRunId) {
      const nodeRun = database.getNodeRun(req.body.nodeRunId);
      if (!nodeRun || nodeRun.runId !== req.params.runId) throw new Error('RunEvent NodeRun 不属于当前 Run');
    }
    const event = database.appendRunEvent(req.params.runId, {
      nodeRunId: req.body?.nodeRunId,
      type: normalizeRunEventType(req.body?.type),
      payload: redactAndScanRunValue(req.body?.payload || {}),
      createdAt: req.body?.createdAt,
    });
    res.status(201).json({ success: true, data: event });
  } catch (error) {
    res.status(400).json({ success: false, error: error?.message || String(error) });
  }
});

router.post('/:runId/nodes', (req, res) => {
  if (!requireRun(req.params.runId, res)) return;
  try {
    if (req.body?.parentNodeRunId) {
      const parent = database.getNodeRun(req.body.parentNodeRunId);
      if (!parent || parent.runId !== req.params.runId) throw new Error('父节点运行记录不属于当前 Run');
    }
    const nodeRun = database.createNodeRun({
      ...req.body,
      runId: req.params.runId,
      status: 'queued',
      inputSnapshot: redactAndScanRunValue(req.body?.inputSnapshot || {}),
    });
    database.appendRunEvent(req.params.runId, {
      nodeRunId: nodeRun.id,
      type: 'node.queued',
      payload: { nodeId: nodeRun.nodeId },
    });
    collaborationGateway.broadcastHostNodeRunState(database.getRun(req.params.runId), nodeRun);
    res.status(201).json({ success: true, data: nodeRun });
  } catch (error) {
    res.status(400).json({ success: false, error: error?.message || String(error) });
  }
});

router.patch('/:runId/nodes/:nodeRunId', (req, res) => {
  if (!requireRun(req.params.runId, res)) return;
  const current = database.getNodeRun(req.params.nodeRunId);
  if (!current || current.runId !== req.params.runId) return res.status(404).json({ success: false, error: '节点运行记录不存在' });
  try {
    const requestedStatus = req.body?.status === undefined ? undefined : normalizeNodeRunStatus(req.body.status);
    const nodeRun = database.updateNodeRun(current.id, {
      status: requestedStatus,
      outputRefs: req.body?.outputRefs,
    });
    const eventType = requestedStatus
      ? nodeRunEventTypeForStatus(requestedStatus)
      : Array.isArray(req.body?.outputRefs)
        ? 'node.output'
        : null;
    if (eventType) {
      database.appendRunEvent(req.params.runId, {
        nodeRunId: nodeRun.id,
        type: eventType,
        payload: redactAndScanRunValue({
          nodeId: nodeRun.nodeId,
          outputRefs: nodeRun.outputRefs,
          ...(req.body?.eventPayload && typeof req.body.eventPayload === 'object' ? req.body.eventPayload : {}),
        }),
      });
    }
    collaborationGateway.broadcastHostNodeRunState(database.getRun(req.params.runId), nodeRun);
    res.json({ success: true, data: nodeRun });
  } catch (error) {
    res.status(400).json({ success: false, error: error?.message || String(error) });
  }
});

router.post('/:runId/nodes/:nodeRunId/attempts', (req, res) => {
  if (!requireRun(req.params.runId, res)) return;
  const nodeRun = database.getNodeRun(req.params.nodeRunId);
  if (!nodeRun || nodeRun.runId !== req.params.runId) return res.status(404).json({ success: false, error: '节点运行记录不存在' });
  try {
    const attempt = database.createAttempt({
      ...req.body,
      nodeRunId: nodeRun.id,
      status: normalizeNodeRunStatus(req.body?.status, 'queued'),
      usage: redactAndScanRunValue(req.body?.usage || {}),
      metadata: redactAndScanRunValue(req.body?.metadata || {}),
      error: req.body?.error ? normalizeRunError(redactAndScanRunValue(req.body.error)) : null,
    });
    res.status(201).json({ success: true, data: attempt });
  } catch (error) {
    res.status(400).json({ success: false, error: error?.message || String(error) });
  }
});

router.patch('/:runId/nodes/:nodeRunId/attempts/:attemptId', (req, res) => {
  if (!requireRun(req.params.runId, res)) return;
  const nodeRun = database.getNodeRun(req.params.nodeRunId);
  if (!nodeRun || nodeRun.runId !== req.params.runId) return res.status(404).json({ success: false, error: '节点运行记录不存在' });
  const attempt = database.getAttempt(req.params.attemptId);
  if (!attempt || attempt.nodeRunId !== req.params.nodeRunId) return res.status(404).json({ success: false, error: '尝试记录不存在' });
  try {
    res.json({
      success: true,
      data: database.updateAttempt(attempt.id, {
        ...req.body,
        status: req.body?.status === undefined ? undefined : normalizeNodeRunStatus(req.body.status),
        usage: req.body?.usage === undefined ? undefined : redactAndScanRunValue(req.body.usage),
        metadata: req.body?.metadata === undefined ? undefined : redactAndScanRunValue(req.body.metadata),
        error: req.body?.error === undefined ? undefined : normalizeRunError(redactAndScanRunValue(req.body.error)),
      }, { runId: req.params.runId, nodeRunId: req.params.nodeRunId }),
    });
  } catch (error) {
    res.status(400).json({ success: false, error: error?.message || String(error) });
  }
});

router.patch('/:runId/nodes/:nodeRunId/attempts/:attemptId/terminal', (req, res) => {
  try {
    const requestedStatus = normalizeNodeRunStatus(req.body?.status);
    if (!TERMINAL_NODE_RUN_STATUSES.has(requestedStatus)) {
      throw new Error(`节点终态不受支持: ${requestedStatus}`);
    }
    const normalizedError = req.body?.error == null
      ? null
      : normalizeRunError(redactAndScanRunValue(req.body.error));
    const timestamps = redactAndScanRunValue(req.body?.timestamps || {});
    const eventPayload = redactAndScanRunValue(
      req.body?.eventPayload && typeof req.body.eventPayload === 'object'
        ? req.body.eventPayload
        : {},
    );
    const commitTerminal = database.db.transaction(() => {
      const run = database.getRun(req.params.runId);
      if (!run) throw new Error('运行记录不存在');
      const currentNodeRun = database.getNodeRun(req.params.nodeRunId);
      if (!currentNodeRun || currentNodeRun.runId !== run.id) {
        throw new Error('节点运行记录不属于当前 Run');
      }
      const currentAttempt = database.getAttempt(req.params.attemptId);
      if (!currentAttempt || currentAttempt.nodeRunId !== currentNodeRun.id) {
        throw new Error('Attempt 不属于当前 Run/NodeRun');
      }
      const attempt = database.updateAttempt(currentAttempt.id, {
        status: requestedStatus,
        timestamps,
        error: normalizedError,
      }, { runId: run.id, nodeRunId: currentNodeRun.id });
      const nodeRun = database.updateNodeRun(currentNodeRun.id, { status: requestedStatus });
      const event = database.appendRunEvent(run.id, {
        nodeRunId: nodeRun.id,
        type: nodeRunEventTypeForStatus(requestedStatus),
        payload: {
          nodeId: nodeRun.nodeId,
          attemptId: attempt.id,
          status: requestedStatus,
          ...eventPayload,
        },
      });
      return { run, nodeRun, attempt, event };
    });
    const result = commitTerminal.immediate();
    collaborationGateway.broadcastHostNodeRunState(result.run, result.nodeRun);
    res.json({
      success: true,
      data: { nodeRun: result.nodeRun, attempt: result.attempt, event: result.event },
    });
  } catch (error) {
    res.status(400).json({ success: false, error: error?.message || String(error) });
  }
});

router.post('/:runId/nodes/:nodeRunId/outputs', async (req, res) => {
  const run = requireRun(req.params.runId, res);
  if (!run) return;
  const nodeRun = database.getNodeRun(req.params.nodeRunId);
  if (!nodeRun || nodeRun.runId !== run.id) return res.status(404).json({ success: false, error: '节点运行记录不存在' });
  try {
    const outputs = redactAndScanRunValue(Array.isArray(req.body?.outputs) ? req.body.outputs : []);
    const result = await assetIndexer.recordRunOutputAssets({
      runId: run.id,
      nodeRunId: nodeRun.id,
      attemptId: req.body?.attemptId,
      outputs,
    });
    database.appendRunEvent(run.id, {
      nodeRunId: nodeRun.id,
      type: 'node.output',
      payload: {
        nodeId: nodeRun.nodeId,
        outputRefs: result.nodeRun.outputRefs,
        assets: result.assets.map((asset) => ({ id: asset.id, kind: asset.kind, filename: asset.filename })),
        ...(req.body?.eventPayload && typeof req.body.eventPayload === 'object' ? redactAndScanRunValue(req.body.eventPayload) : {}),
      },
    });
    collaborationGateway.broadcastHostNodeRunState(run, result.nodeRun);
    collaborationGateway.broadcastHostRunOutput(run, result.nodeRun, result.assets);
    res.status(201).json({
      success: true,
      data: { nodeRun: result.nodeRun, assets: result.assets.map(publicAsset) },
    });
  } catch (error) {
    res.status(400).json({ success: false, error: error?.message || String(error) });
  }
});

module.exports = router;
